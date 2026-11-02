# Big-data course guide

## Research question

How does a stateful weather stream behave as event volume, arrival rate, duplicate rate, and lateness increase? Can a replayable data lake support both low-latency geographic exploration and batch regional analytics?

Twenty-five weather locations alone do not constitute big data. The value of this project is the real Spark pipeline plus controlled, explicitly synthetic scale experiments. Report observed dataset sizes and performance rather than calling a small API response “big data.”

## Map the project to the course

| Concept | Implementation | Evidence to collect |
| --- | --- | --- |
| Volume | Parameterized synthetic event generation, Parquet lake | Rows, file bytes, compression, partition count |
| Velocity | Incremental file stream and 10-second micro-batches | Input/processed rows per second, trigger duration, backlog |
| Variety | Current observations, hourly/daily forecasts, geometry | Schema diagram and format examples |
| Veracity | Source labels, schema checks, quarantine, deduplication | Valid/rejected/duplicate counts and sample records |
| Value | 3D comparison, forecast planning, regional analysis | A user story backed by a dashboard view |
| Distributed computation | Spark DataFrames, shuffle aggregation, partitions | Explain `local[2]` versus an actual cluster |
| Event time | Watermarks and sliding windows | Late-event experiment and state eviction metrics |
| Fault tolerance | Checkpoints and retry-safe batch outputs | Stop/restart experiment with unchanged bronze counts |

## Suggested experiments

Use a **separate data directory per experiment** so existing checkpoints, cache, or previous inputs do not distort comparisons. Record hardware, Spark/Python/Java versions, worker count, shuffle partitions, memory, and storage type. Do not mix load-test data with provider observations in analysis.

### A. Scale and throughput

Run 10,000, 100,000, then 1,000,000 events. Increase only one factor at a time. Begin with 5,000 events per file and 0.2 seconds between files:

```bash
python scripts/generate_load.py --events 100000 --batch-size 5000 --interval 0.2
```

For each run, report producer throughput separately from Spark throughput. Generator speed is not pipeline speed. Capture the Spark UI's Structured Streaming query metrics: `numInputRows`, `inputRowsPerSecond`, `processedRowsPerSecond`, `durationMs`, state-store rows/bytes, and watermark. Measure total end-to-end completion time after the final input file arrives.

### B. Data quality

Compare runs with no errors, then 1% and 10% invalid new events. Use `--invalid-rate`, `--duplicate-rate`, and `--late-rate`. Validate quarantine includes out-of-range temperatures. The generator prints counts of new invalid events and duplicate rows; duplicate copies of invalid events can increase quarantine rows, since quarantine preserves rejected input rather than deduplicating it.

### C. Late events

First send current-time data and wait for at least two successful triggers. Then publish old observations. Compare default 20-minute watermark behavior with a separate fresh-checkpoint run using a different watermark. Explain the tradeoff between accepting late data and memory usage. A timestamp older than arrival by 45 minutes is not automatically rejected in the first batch, because a watermark has not necessarily advanced yet.

### D. Recovery

Record bronze row counts. Stop and restart Spark while retaining all checkpoints and sink metadata. Confirm committed source files do not create new bronze duplicates. Then add a new input file and verify processing resumes. Do not reset checkpoints against an existing lake and claim the result has the same guarantees.

### E. Partition and storage design

Run batch SQL over bronze and measure query time. Compare file counts and bytes before/after a separately written compaction job. Discuss the small-files problem caused by frequent micro-batches. For multi-node execution, move data and checkpoints to shared storage and adapt gold publishing; local container files are not a distributed filesystem.

## Result table template

| Events | Input MB | Batch size | Workers | Invalid % | Duplicate % | Total duration | Spark rows/s | Max state MB | Bronze rows | Quarantine rows |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 | measure | 5,000 | 2 | 1 | 5 | measure | measure | measure | measure | measure |
| 100,000 | measure | 5,000 | 2 | 1 | 5 | measure | measure | measure | measure | measure |
| 1,000,000 | measure | 5,000 | 2 | 1 | 5 | measure | measure | measure | measure | measure |

Never invent throughput or fill this table with unmeasured estimates.

## Ten-minute demonstration

1. Explain Vietnam coverage, provider data, and synthetic labels (1 minute).
2. Select cities, compare map layers, play a forecast, and inspect daily weather (2 minutes).
3. Walk through the pipeline and event schema (2 minutes).
4. Generate a workload, show Spark query progress and quarantine (2 minutes).
5. Show measured experiment results and batch SQL (2 minutes).
6. Explain limitations and production extensions (1 minute).

## Suggested report structure

Problem and objectives; data provenance; functional requirements; system architecture; ingestion/data contracts; Spark stateful processing; storage model; user interface; correctness testing; experimental methodology; measured results; limitations; conclusion and references.
