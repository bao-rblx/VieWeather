"""Create deterministic synthetic stream batches, including duplicates and invalid data."""

import argparse
import hashlib
import json
import random
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--events", type=int, default=100000)
    p.add_argument("--batch-size", type=int, default=5000)
    p.add_argument("--interval", type=float, default=0.1)
    p.add_argument("--output", type=Path, default=Path("data/incoming"))
    p.add_argument("--duplicate-rate", type=float, default=0.05)
    p.add_argument("--invalid-rate", type=float, default=0.01)
    p.add_argument("--late-rate", type=float, default=0.02)
    args = p.parse_args()
    if (
        args.events < 1
        or args.batch_size < 1
        or args.interval < 0
        or any(
            not 0 <= v <= 1
            for v in [args.duplicate_rate, args.invalid_rate, args.late_rate]
        )
    ):
        p.error("Counts must be positive, interval nonnegative, and rates in [0,1].")
    cities = json.loads(
        (Path(__file__).resolve().parents[1] / "backend/cities.json").read_text()
    )
    args.output.mkdir(parents=True, exist_ok=True)
    rng = random.Random(42)
    run = uuid.uuid4().hex
    start = time.monotonic()
    duplicates = invalid = late = 0
    previous = None
    for offset in range(0, args.events, args.batch_size):
        lines = []
        now = datetime.now(timezone.utc)
        for i in range(offset, min(offset + args.batch_size, args.events)):
            if previous and rng.random() < args.duplicate_rate:
                event = dict(previous)
                duplicates += 1
            else:
                city = rng.choice(cities)
                is_late = rng.random() < args.late_rate
                event_time = now - timedelta(
                    minutes=45 if is_late else rng.uniform(0, 5)
                )
                late += int(is_late)
                bad = rng.random() < args.invalid_rate
                invalid += int(bad)
                event = {
                    "event_id": hashlib.sha256(f"{run}:{i}".encode()).hexdigest(),
                    "city_id": city["id"],
                    "region": city["region"],
                    "event_time": event_time.isoformat(),
                    "ingested_at": now.isoformat(),
                    "source": "load-test",
                    "temperature": 999.0 if bad else round(rng.uniform(17, 37), 2),
                    "humidity": round(rng.uniform(40, 100), 2),
                    "wind": round(rng.uniform(0, 60), 2),
                    "precipitation": round(rng.uniform(0, 12), 2),
                }
                previous = event
            lines.append(json.dumps(event))
        dest = args.output / f"load-{run}-{offset:012d}.json"
        temp = dest.with_suffix(".tmp")
        temp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        temp.replace(dest)
        if args.interval:
            time.sleep(args.interval)
    elapsed = time.monotonic() - start
    print(
        json.dumps(
            {
                "run": run,
                "events": args.events,
                "duplicate_rows": duplicates,
                "new_invalid_events": invalid,
                "new_late_events": late,
                "seconds": round(elapsed, 3),
                "generator_events_per_second": round(args.events / elapsed),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
