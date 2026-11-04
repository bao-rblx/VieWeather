"""Exercise the actual streaming job, quarantine, aggregation, and checkpoint recovery.

Run with Python 3.11, Java 17, and pyspark==3.5.3 installed. No pytest required.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]


def wait_for(predicate, process, log, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(
                f"Spark stopped with code {process.returncode}:\n{log.read_text()[-8000:]}"
            )
        result = predicate()
        if result:
            return result
        time.sleep(1)
    raise AssertionError(f"Spark timed out:\n{log.read_text()[-8000:]}")


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def main():
    import pyspark

    submit = Path(pyspark.__file__).parent / "bin" / "spark-submit"
    folder = Path(tempfile.mkdtemp(prefix="vieweather-smoke-"))
    incoming = folder / "incoming"
    incoming.mkdir()
    env = {
        **os.environ,
        "DATA_DIR": str(folder),
        "PYSPARK_PYTHON": sys.executable,
        "SPARK_SHUFFLE_PARTITIONS": "2",
        "SPARK_LOCAL_IP": "127.0.0.1",
    }
    log = folder / "spark.log"
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    def event(index, temp=25.0, humidity=70.0):
        return {
            "event_id": hashlib.sha256(str(index).encode()).hexdigest(),
            "city_id": "hanoi",
            "region": "North",
            "event_time": now,
            "ingested_at": now,
            "source": "load-test",
            "temperature": temp,
            "humidity": humidity,
            "wind": 10.0,
            "precipitation": 0.0,
        }

    valid1, valid2 = event(1, 24.0), event(2, 28.0)
    # Includes duplicate, range violation, null value, and malformed JSON.
    rows = [valid1, valid1, valid2, event(3, 999.0), event(4, humidity=None)]
    (incoming / "batch-1.json").write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n{malformed\n"
    )

    def start():
        handle = log.open("a")
        p = subprocess.Popen(
            [
                str(submit),
                "--master",
                "local[2]",
                "--driver-memory",
                "1g",
                str(ROOT / "pipeline/stream.py"),
            ],
            env=env,
            stdout=handle,
            stderr=subprocess.STDOUT,
        )
        handle.close()
        return p

    def latest():
        files = sorted((folder / "gold").glob("batch-*.json"))
        return json.loads(files[-1].read_text()) if files else None

    process = start()
    try:
        first = wait_for(latest, process, log)
        assert len(first["windows"]) == 2, first
        assert all(
            w["event_count"] == 2 and w["avg_temperature"] == 26.0
            for w in first["windows"]
        ), first
        stop(process)
        # Same event IDs in a newly arrived file must not inflate the windows after restart.
        rows2 = [valid1, event(5, 32.0)]
        (incoming / "batch-2.json").write_text(
            "\n".join(json.dumps(r) for r in rows2) + "\n"
        )
        process = start()
        second = wait_for(
            lambda: (
                v if (v := latest()) and v["batchId"] > first["batchId"] else None
            ),
            process,
            log,
        )
        assert all(
            w["event_count"] == 3 and w["avg_temperature"] == 28.0
            for w in second["windows"]
        ), second
        stop(process)
        from pyspark.sql import SparkSession

        spark = (
            SparkSession.builder.master("local[1]")
            .appName("VieWeather-Smoke-Verify")
            .config("spark.ui.enabled", "false")
            .getOrCreate()
        )
        spark.sparkContext.setLogLevel("ERROR")
        bronze = spark.read.parquet(str(folder / "bronze"))
        rejected = spark.read.parquet(str(folder / "quarantine"))
        assert bronze.count() == 3, bronze.collect()
        assert rejected.count() == 3, rejected.collect()
        spark.stop()
        print(
            json.dumps(
                {
                    "status": "passed",
                    "bronze_events": 3,
                    "quarantined_events": 3,
                    "windows": 2,
                    "deduplication": "passed",
                    "restart_recovery": "passed",
                    "data_directory": str(folder),
                },
                indent=2,
            )
        )
    finally:
        if process.poll() is None:
            stop(process)


if __name__ == "__main__":
    main()
