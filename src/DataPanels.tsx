import {
  Activity,
  ArrowRight,
  BarChart3,
  Database,
  Download,
  Radio,
  SlidersHorizontal,
} from "lucide-react";
import { type Analytics, hourLabel, temperature } from "./types";

export function AnalyticsPanel({
  analytics: a,
  fahrenheit,
}: {
  analytics: Analytics | null;
  fahrenheit: boolean;
}) {
  if (!a)
    return (
      <div className="empty">
        Waiting for analytics. Check the API connection.
      </div>
    );
  return (
    <>
      <div className="metric-grid">
        <MetricCard
          title="Stored observations"
          value={a.counts
            .reduce((sum, item) => sum + item.events, 0)
            .toLocaleString()}
          note="Deduplicated by city, time and source"
          icon={<Database />}
        />
        <MetricCard
          title="Live observations"
          value={(
            a.counts.find((item) => item.source === "open-meteo")?.events || 0
          ).toLocaleString()}
          note="Provider data only"
          icon={<Radio />}
        />
        <MetricCard
          title="Input files"
          value={a.incomingFiles.toLocaleString()}
          note="Atomic JSON batches for Spark"
          icon={<Activity />}
        />
        <MetricCard
          title="Spark processor"
          value={a.spark.status}
          note={
            a.spark.updatedAt
              ? `Last output ${hourLabel(a.spark.updatedAt)}`
              : "Start the Docker streaming profile"
          }
          icon={<SlidersHorizontal />}
        />
      </div>
      <section className="panel analytics-panel">
        <div className="section-bar">
          <div>
            Regional observations{" "}
            <span className="subtitle">Last hour · grouped by source</span>
          </div>
          <a className="text-button" href="/api/export">
            <Download size={15} />
            Export CSV
          </a>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  "Region",
                  "Source",
                  "Observations",
                  "Avg. temperature",
                  "Avg. humidity",
                  "Peak wind",
                ].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {a.regions.map((region) => (
                <tr key={region.region + region.source}>
                  <td>
                    <b>{region.region}</b>
                  </td>
                  <td>
                    <span className="tiny-tag">{region.source}</span>
                  </td>
                  <td>{region.events.toLocaleString()}</td>
                  <td>{temperature(region.temperature, fahrenheit)}°</td>
                  <td>{region.humidity}%</td>
                  <td>{region.maxWind} km/h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel analytics-panel">
        <div className="section-bar">
          <div>
            Spark event-time windows{" "}
            <span className="subtitle">10-minute windows · 5-minute slide</span>
          </div>
          <span className="tiny-tag">{a.spark.status}</span>
        </div>
        {a.spark.windows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "City",
                    "Source",
                    "Window start (ICT)",
                    "Events",
                    "Avg. temperature",
                  ].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {a.spark.windows.slice(0, 20).map((window, index) => (
                  <tr key={index}>
                    <td>{window.city_id}</td>
                    <td>{window.source}</td>
                    <td>{hourLabel(window.window.start)}</td>
                    <td>{window.event_count}</td>
                    <td>{temperature(window.avg_temperature, fahrenheit)}°</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            <Database size={28} />
            <h3>No Spark output yet</h3>
            <p>
              Run <code>docker compose --profile streaming up --build</code> to
              process incoming observations.
              <br />
              The regional table above is computed by the API, independently of
              Spark.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
function MetricCard({
  title,
  value,
  note,
  icon,
}: {
  title: string;
  value: string;
  note: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric-card">
      <div>
        <span>{title}</span>
        {icon}
      </div>
      <strong>{value}</strong>
      <p>{note}</p>
    </div>
  );
}
export function PipelinePanel({
  analytics: a,
}: {
  analytics: Analytics | null;
}) {
  return (
    <>
      <section className="panel pipeline-panel">
        <div className="section-bar">
          <div>The weather data journey</div>
          <span className="tiny-tag">Structured Streaming</span>
        </div>
        <div className="pipeline-flow">
          {[
            {
              icon: Radio,
              name: "Collect",
              desc: "Open-Meteo / demo",
              detail: "25 monitored cities",
            },
            {
              icon: Database,
              name: "Land",
              desc: "Atomic JSON batches",
              detail: "Replayable event log",
            },
            {
              icon: Activity,
              name: "Process",
              desc: "Apache Spark",
              detail: "Watermarks + windows",
            },
            {
              icon: BarChart3,
              name: "Explore",
              desc: "Parquet + JSON",
              detail: "Lake + dashboard",
            },
          ].map(({ icon: Icon, name, desc, detail }, index) => (
            <div className="pipeline-step" key={name}>
              <span className="step-icon">
                <Icon size={23} />
              </span>
              <small>0{index + 1}</small>
              <h3>{name}</h3>
              <p>{desc}</p>
              <span>{detail}</span>
              {index < 3 && <ArrowRight className="step-arrow" size={20} />}
            </div>
          ))}
        </div>
        <div className="pipeline-info">
          <span>API: {a ? "connected" : "connecting"}</span>
          <span>
            Spark: <b>{a?.spark.status || "unknown"}</b>
          </span>
          <span>
            Collection mode: <b>{a?.mode || "unknown"}</b>
          </span>
        </div>
      </section>
      <section className="panel analytics-panel">
        <div className="section-bar">
          Spark streaming queries
          <span className="tiny-tag">Latest trigger</span>
        </div>
        {a?.spark.queries?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "Query",
                    "Status",
                    "Batch",
                    "Input rows",
                    "Rows / second",
                    "State rows",
                    "State memory",
                  ].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {a.spark.queries.map((query) => (
                  <tr key={query.name}>
                    <td>{query.name}</td>
                    <td>{query.active ? "Active" : "Stopped"}</td>
                    <td>{query.progress?.batchId ?? "—"}</td>
                    <td>
                      {query.progress?.numInputRows.toLocaleString() ?? "—"}
                    </td>
                    <td>
                      {query.progress?.processedRowsPerSecond.toFixed(1) ?? "—"}
                    </td>
                    <td>
                      {query.progress?.stateOperators
                        ?.reduce((sum, op) => sum + op.numRowsTotal, 0)
                        .toLocaleString() ?? "—"}
                    </td>
                    <td>
                      {query.progress?.stateOperators
                        ? `${(query.progress.stateOperators.reduce((sum, op) => sum + op.memoryUsedBytes, 0) / 1048576).toFixed(2)} MB`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            No streaming query metrics available. Start the Spark streaming
            profile.
          </div>
        )}
      </section>
      <div className="pipeline-grid">
        <section className="panel">
          <div className="section-bar">
            Recent observations
            <span className="tiny-tag">Refreshes every 10s</span>
          </div>
          <div className="event-list">
            {a?.recent.map((event) => (
              <div key={event.event_id}>
                <span className="event-icon">
                  <Activity size={14} />
                </span>
                <div>
                  <b>{event.city_id}</b>
                  <span>
                    {event.source} · {event.temperature} °C · {event.humidity}%
                    RH
                  </span>
                </div>
                <time>{hourLabel(event.event_time)}</time>
              </div>
            ))}
          </div>
          {!a?.recent.length && (
            <div className="empty">No recent observations.</div>
          )}
        </section>
        <section className="panel course-panel">
          <span className="eyebrow">BUILT FOR BIG DATA</span>
          <h2>More than a forecast.</h2>
          <p>
            A reproducible pipeline for studying volume, velocity, variety, and
            data quality.
          </p>
          <a className="text-button" href="/api/export">
            <Download size={16} />
            Export observations
          </a>
          <a
            className="text-button"
            href="/docs"
            target="_blank"
            rel="noreferrer"
          >
            Explore the API
            <ArrowRight size={16} />
          </a>
          <p>
            Last provider poll:{" "}
            {a?.lastPoll ? hourLabel(a.lastPoll) : "Not yet available"}
          </p>
          {a?.providerError && <p>{a.providerError}</p>}
        </section>
      </div>
    </>
  );
}
