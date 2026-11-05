"""The single owner of the Open-Meteo request budget.

Measured from the provider's own response headers, the free tier meters every call
against *two* windows at once:

    minute:  x-ratelimit-limit 600    window 60 s
    hour:    x-ratelimit-limit 5000   window 3600 s

and the cost of one call is roughly "coordinates x variables" (a 20x17 "current"
grid = 340 units, a 25-city "current + hourly + daily" poll = ~75). Both windows
were being blown:

  * the minute window, because a 26x22 grid refresh (572) plus the 25-city poll in
    the same minute was 95 % + 12 % of the budget, so a cold start 429'd itself and
    fell back to synthesized data;
  * the hour window, because every retry and every model switch spent units that
    nothing was counting, so after enough testing the whole hour went dark and the
    app stayed on fallback data until the hour rolled over.

Every Open-Meteo call in this backend now reserves its units here first, against both
windows. A call that would overshoot waits for the window it needs (a few seconds,
never a lost data cycle); a 429 drains both windows and pauses until the provider's
own Retry-After, so nothing retries into a closed door.

Standard library + asyncio only.
"""

from __future__ import annotations

import asyncio
import logging
import time

log = logging.getLogger("vieweather.budget")

MINUTE_WINDOW = (600.0, 60.0)  # units, seconds
HOUR_WINDOW = (5000.0, 3600.0)
CAPACITY = MINUTE_WINDOW[0]
DEFAULT_TIMEOUT = 30.0  # how long a foreground request may wait for tokens


class BudgetExhausted(RuntimeError):
    """The window is too full to run this call within the caller's patience."""

    def __init__(self, wait):
        super().__init__("provider budget busy for another " + str(round(wait, 1)) + "s")
        self.wait = wait


class TokenBucket:
    """Rolling-window token bucket over one or more windows.

    Units are reserved *before* the request: an over-eager reservation wastes a few
    tokens, an under-eager one earns a 429, and the first is the safer mistake.
    """

    def __init__(self, capacity=None, window=None, windows=None):
        spec = list(windows) if windows else [(capacity or CAPACITY, window or MINUTE_WINDOW[1])]
        now = time.monotonic()
        self.windows = [
            {
                "capacity": float(cap),
                "window": float(win),
                "rate": float(cap) / float(win),
                "tokens": float(cap),
                "updated": now,
            }
            for cap, win in spec
        ]
        self.spent = 0.0
        self.reserved_total = 0
        self.paused_until = 0.0
        self._lock = None
        self._loop = None

    # -- internals ---------------------------------------------------------
    def _guard(self):
        """A lock tied to the running loop (tests use one loop per asyncio.run)."""
        loop = asyncio.get_running_loop()
        if self._lock is None or self._loop is not loop:
            self._lock = asyncio.Lock()
            self._loop = loop
        return self._lock

    @staticmethod
    def _refill(bucket_window, now):
        elapsed = now - bucket_window["updated"]
        if elapsed > 0:
            bucket_window["tokens"] = min(
                bucket_window["capacity"],
                bucket_window["tokens"] + elapsed * bucket_window["rate"],
            )
        bucket_window["updated"] = now

    def _wait_for(self, want, now):
        """Seconds until every window can afford *want* units."""
        pause = self.paused_until - now
        if pause > 0:
            return pause
        wait = 0.0
        for bucket_window in self.windows:
            shortfall = want - bucket_window["tokens"]
            if shortfall > 0:
                wait = max(wait, shortfall / bucket_window["rate"])
        return wait

    # -- public ------------------------------------------------------------
    @property
    def capacity(self):
        return self.windows[0]["capacity"]

    @property
    def rate(self):
        return self.windows[0]["rate"]

    def available(self):
        """Units the tightest window can still afford (the honest number)."""
        now = time.monotonic()
        best = None
        for bucket_window in self.windows:
            self._refill(bucket_window, now)
            if best is None or bucket_window["tokens"] < best:
                best = bucket_window["tokens"]
        return max(0.0, best or 0.0)

    def available_in(self, index):
        now = time.monotonic()
        self._refill(self.windows[index], now)
        return max(0.0, self.windows[index]["tokens"])

    async def reserve(self, units, timeout=None):
        """Block until every window can afford *units*, take them, and return them.

        timeout=None waits as long as it takes (background refreshes); a number
        raises BudgetExhausted instead of making an HTTP request hang.
        """
        want = max(1.0, min(float(units), min(w["capacity"] for w in self.windows)))
        deadline = None if timeout is None else time.monotonic() + float(timeout)
        while True:
            async with self._guard():
                now = time.monotonic()
                for bucket_window in self.windows:
                    self._refill(bucket_window, now)
                wait = self._wait_for(want, now)
                if wait <= 0:
                    for bucket_window in self.windows:
                        bucket_window["tokens"] -= want
                    self.spent += want
                    self.reserved_total += 1
                    return want
            if deadline is None:
                await asyncio.sleep(min(max(wait, 0.01) + 0.05, 5.0))
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0 or wait > remaining:
                raise BudgetExhausted(max(wait, 0.0))
            await asyncio.sleep(min(max(wait, 0.01) + 0.05, remaining))

    def drain(self, seconds=MINUTE_WINDOW[1]):
        """After a 429: hand back every window and stop asking for a while."""
        now = time.monotonic()
        for bucket_window in self.windows:
            self._refill(bucket_window, now)
            bucket_window["tokens"] = 0.0
        self.paused_until = max(self.paused_until, now + float(seconds))
        log.warning("Provider said 429; pausing provider calls for %ss", round(seconds))

    def snapshot(self):
        now = time.monotonic()
        windows = []
        for bucket_window in self.windows:
            self._refill(bucket_window, now)
            windows.append(
                {
                    "window": bucket_window["window"],
                    "capacity": bucket_window["capacity"],
                    "available": round(max(0.0, bucket_window["tokens"]), 1),
                }
            )
        return {
            "capacity": self.capacity,
            "available": round(self.available(), 1),
            "windows": windows,
            "pausedFor": round(max(0.0, self.paused_until - now), 1),
            "spent": round(self.spent, 1),
            "calls": self.reserved_total,
        }


# The process-wide budget every Open-Meteo call goes through.
FORECAST_BUDGET = TokenBucket(windows=[MINUTE_WINDOW, HOUR_WINDOW])
