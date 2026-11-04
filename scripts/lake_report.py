"""Report actual lake counts by source for course experiments. Run with spark-submit."""

import json
import os
from pathlib import Path
from pyspark.sql import SparkSession

data = Path(os.getenv("DATA_DIR", "data"))
spark = SparkSession.builder.appName("VieWeather-Lake-Report").getOrCreate()
spark.sparkContext.setLogLevel("ERROR")
result = {}
for name in ("bronze", "quarantine"):
    if any((data / name).rglob("*.parquet")):
        frame = spark.read.parquet(str(data / name))
        result[name] = [
            row.asDict() for row in frame.groupBy("source").count().collect()
        ]
        if name == "bronze":
            result["unique_bronze_ids"] = frame.select("event_id").distinct().count()
        result[name + "_bytes"] = sum(
            p.stat().st_size for p in (data / name).rglob("*.parquet")
        )
    else:
        result[name] = []
result["input_bytes"] = sum(
    p.stat().st_size for p in (data / "incoming").glob("*.json")
)
result["input_files"] = len(list((data / "incoming").glob("*.json")))
spark.stop()
print(json.dumps(result, indent=2))
