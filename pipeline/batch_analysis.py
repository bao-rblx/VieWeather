"""Example batch analytics over the partitioned bronze lake."""

import os
from pyspark.sql import SparkSession

spark = SparkSession.builder.appName("VieWeather-Batch-Analysis").getOrCreate()
spark.read.parquet(f"{os.getenv('DATA_DIR','/data')}/bronze").createOrReplaceTempView(
    "weather"
)
spark.sql("""
SELECT event_date, region, source, count(*) AS observations,
       round(avg(temperature),2) AS avg_temperature,
       percentile_approx(temperature,0.95) AS p95_temperature,
       max(wind) AS peak_wind
FROM weather
GROUP BY event_date, region, source
ORDER BY event_date DESC, region, source
""").show(100, truncate=False)
spark.stop()
