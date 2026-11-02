# Run log

One line per run. Append only; never edit an earlier line.
The Notes column is where credibility is won: say what a run does **not** establish.

| Run | Date and time | Code state | Versions | Configuration | Input | Result — producer | Result — pipeline | Result — state | Notes |
|---|---|---|---|---|---|---|---|---|---|
| R-001 | 2026-11-01 16:07 +07 | pre-commit working tree | Spark 3.5.3 · Java 17.0.21 · Python 3.11.18 · Linux/WSL2 | `local[2]` · driver 2g · shuffle partitions 4 · trigger 10s · watermark 20 min | `generate_load.py --events 100000 --batch-size 5000 --interval 0.2`; seed 42 | 100,000 rows in 4.828 s = 20,713 rows/s (producer, not pipeline) | 92,061 unique load-test rows in bronze · 1,027 quarantined · 7.84 MB Parquet from 32.71 MB JSON | max state size from the Spark UI, not sampled per window | Single run, deliberately paced by a 0.2 s sleep between micro-batches. Not a benchmark. Compare only against runs with the same configuration. |
| R-002 | 2026-11-01 21:02 +07 | same | Spark 3.5.3 · Java 17.0.21 · Linux/WSL2 | same as R-001 | replay of the committed incoming files | n/a — no producer involved | gold batch 43 emitted 50 windows; silver 92 Parquet files | checkpoint state reused, no replay of committed input | Replay run. Proves the derived layers rebuild from raw input; says nothing about throughput. |
| R-003 | 2026-11-10 04:12 +07 | committed tree | Node 24.16.0 · Python 3.12.14 · Windows 11 | single process, no Spark | `generate_load.py --events 100000 --batch-size 5000 --interval 0.05` | 100,000 events in 1.735 s write time = 57,637 events/s · 20 atomic files · 32,691,627 bytes | not run — this measures the producer only | n/a | Producer throughput only. The interval differs from R-001 by design, which is why the figure is higher; the difference is sleep between micro-batches, not processing speed. |

## What to compare across runs

Change one factor at a time. Two changes produce a result you cannot attribute,
which is the same as no result.

| Experiment | Vary | Record |
|---|---|---|
| Scale | Volume: 10k, 100k, 1M | Input bytes, trigger durations, processed rows per second, total completion time, file count |
| Quality | Invalid rate: 0%, 1%, 10% | Valid, rejected and quarantined counts, and sample rejected records |
| Lateness | Watermark: 20 min versus 5 min | Accepted versus dropped late events, and maximum state size — the trade-off is the point |
| Recovery | Stop and restart with checkpoints | Bronze counts before and after, and whether committed input replayed |
| Storage | Before and after compaction | File count, total bytes, query time for the same SQL |
