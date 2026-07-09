# TSDB

TSDB is a local time-series database for Obsidian. It records metrics from this
vault and from other plugins, stores them in a durable SQLite database inside
the vault's plugin folder, and lets notes render live charts with PromQL code
blocks.

The default path is local and offline: collect metrics, keep history, query the
local database, and chart the results in Obsidian. Prometheus HTTP serving and
external endpoint scraping are available under advanced settings.

## What it does

- **Local time-series database**: stores samples in SQLite through `wa-sqlite`
  and a vault-adapter VFS, so data is persisted as chunk files without native
  modules.
- **Plugin metric registration**: other plugins register named metric stores
  with `app.plugins.plugins["tsdb"].api.getStore(...)` or the `tsdb:ready`
  workspace event.
- **PromQL queries**: query stored metrics with a practical subset of PromQL,
  including selectors, aggregations, rates, range functions, binary operators,
  and `histogram_quantile`.
- **Embedded charts**: render live time series, stat, and table panels from
  fenced `promql` code blocks in notes.
- **Built-in vault metrics**: records file activity, note counts, vault size,
  enabled plugin count, open note count, note view time, and browser memory when
  available.
- **Prometheus interop**: optionally expose a local Prometheus-compatible HTTP
  server and scrape Prometheus exposition endpoints into the same local store.

## Installation

### Manual installation

1. Clone this repository into your vault's `.obsidian/plugins/` folder:

   ```bash
   cd /path/to/your/vault/.obsidian/plugins/
   git clone https://github.com/dtkav/obsidian-tsdb.git
   ```

2. Install dependencies and build:

   ```bash
   cd obsidian-tsdb
   npm install
   npm run build
   ```

3. Enable **TSDB** in **Settings -> Community plugins**.

## Time-Series Database

TSDB records metric samples into a SQLite database stored under the plugin
folder. The database lives in `metrics-tsdb/` as 64 KiB chunks, plus a
`metrics.wal` recovery log. Each scrape batch is committed as a SQLite
transaction, and retention pruning removes old samples on a schedule.

The local database is the center of the plugin:

- Built-in metric stores record this vault's own activity.
- Plugin-provided stores record metrics from other Obsidian plugins.
- Optional scrape jobs record external Prometheus endpoints.
- Note charts and dashboards query the database directly, without needing the
  HTTP server.

The default retention is 30 days. Change it in **Settings -> Community plugins
-> TSDB -> Database**.

### Built-in metrics

TSDB creates two built-in stores:

- `vault`: file operations, note counts, vault size, open notes, enabled
  plugins, and note view duration.
- `performance`: browser memory usage and selected Obsidian API timings.

Examples:

- `obsidian_file_operations_total`
- `obsidian_vault_files_total`
- `obsidian_vault_notes_total`
- `obsidian_vault_size_bytes`
- `obsidian_active_notes_count`
- `obsidian_plugins_enabled_total`
- `obsidian_note_view_duration_seconds`
- `obsidian_browser_memory_usage_bytes`
- `obsidian_app_performance_timing_seconds`

All metrics include `vault_name` and `vault_id` labels automatically.

## Plugin Registration

Other plugins register metrics by claiming a named store. A store is recorded
into the local database at its own interval, and the store name becomes the
`job` label for stored samples.

Copy `obsidian-metrics.d.ts` into your plugin for type-safe access.

```typescript
import { Plugin } from "obsidian";
import {
	IObsidianMetricsRootAPI,
	IObsidianMetricsAPI,
	MetricInstance,
	ObsidianMetricsPlugin,
} from "./obsidian-metrics";

export default class MyPlugin extends Plugin {
	private metrics: IObsidianMetricsAPI | undefined;
	private documentSize: MetricInstance | undefined;

	async onload() {
		this.registerEvent(
			this.app.workspace.on("tsdb:ready", (api: IObsidianMetricsRootAPI) => {
				this.registerMetrics(api);
			})
		);

		const tsdb = this.app.plugins.plugins["tsdb"] as
			| ObsidianMetricsPlugin
			| undefined;
		if (tsdb?.api) {
			this.registerMetrics(tsdb.api);
		}
	}

	private registerMetrics(rootApi: IObsidianMetricsRootAPI) {
		const api = rootApi.getStore("my-plugin", {
			intervalSeconds: 30,
			displayName: "My plugin metrics",
			description: "Document size and activity metrics.",
		});

		this.metrics = api;
		this.documentSize = api.createGauge({
			name: "my_document_size_bytes",
			help: "Size of documents in bytes.",
			labelNames: ["document"],
		});
	}

	updateDocumentSize(document: string, bytes: number) {
		this.documentSize?.labels({ document }).set(bytes);
	}
}
```

Registration is idempotent. If TSDB reloads, `tsdb:ready` fires again and your
plugin should recreate its store and metric references. Do not keep old API or
metric instances across TSDB reloads.

### Metric types

TSDB exposes the familiar Prometheus metric types through `prom-client`:

```typescript
const counter = api.createCounter({
	name: "requests_total",
	help: "Total requests.",
	labelNames: ["route"],
});
counter.inc(1, { route: "search" });

const gauge = api.createGauge({
	name: "queue_depth",
	help: "Current queue depth.",
});
gauge.set(12);

const histogram = api.createHistogram({
	name: "operation_duration_seconds",
	help: "Operation duration.",
	labelNames: ["operation"],
	buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
});
const stop = histogram.startTimer({ operation: "index" });
// do work
stop();
```

Convenience helpers are also available:

```typescript
api.counter("button_clicks_total", "Button click count.").inc();
api.gauge("active_documents", "Open document count.", 3);
api.histogram("request_duration_seconds", "Request duration.");
```

## Charting In Notes

TSDB registers a `promql` Markdown code block processor. Add a fenced block to
any note and it renders as a live panel backed by the local database.

### Time series

````markdown
```promql
query: sum by (operation) (rate(obsidian_file_operations_total[5m]))
title: File operations per second
legend: "{{operation}}"
range: 3h
refresh: 30s
```
````

### Stat

````markdown
```promql
query: obsidian_vault_notes_total
type: stat
title: Notes
refresh: 60s
```
````

### Table

````markdown
```promql
query: scrape_samples_scraped
type: table
title: Scrape samples
refresh: 30s
```
````

Panel options:

- `query`: a PromQL expression.
- `queries`: multiple expressions with optional `legend` values.
- `type`: `timeseries`, `stat`, or `table`.
- `title`: panel title.
- `range`: time range for time series panels, such as `1h` or `3h`.
- `step`: query step; omitted means automatic.
- `refresh`: refresh interval; omitted means render once.
- `unit`: display unit, including `bytes`.
- `legend`: label template such as `{{operation}} on {{instance}}`.
- `min`, `max`, `height`: chart display controls.

Use the ribbon icon or the **Open metrics dashboard** command to open the
built-in dashboard. Select **Edit in my vault** from that dashboard to create a
normal Markdown note you can customize.

## Querying

The charting layer and dashboard query the local TSDB directly. The same engine
also powers the optional Prometheus-compatible HTTP API.

Supported PromQL subset:

- Selectors with `=`, `!=`, `=~`, `!~`, range selectors such as `[5m]`, and
  `offset`.
- `rate`, `irate`, `increase`, `delta`, `idelta`, `changes`, `resets`, and
  `*_over_time` functions for avg, min, max, sum, count, last, present,
  stddev, stdvar, and quantile.
- `histogram_quantile`, `abs`, `ceil`, `floor`, `round`, `sqrt`, `exp`, `ln`,
  `log2`, `log10`, `sgn`, `clamp`, `clamp_min`, `clamp_max`, `scalar`,
  `vector`, `time`, `absent`, `sort`, and `sort_desc`.
- Aggregations: `sum`, `avg`, `min`, `max`, `count`, `stddev`, `stdvar`,
  `quantile`, `topk`, and `bottomk` with `by` and `without`.
- Binary operators: arithmetic, comparisons including `bool`, `and`, `or`,
  `unless`, and one-to-one vector matching with `on` and `ignoring`.

Not supported yet: subqueries, `@` modifiers, `group_left`, `group_right`,
`label_replace`, and `label_join`.

## Settings

Open **Settings -> Community plugins -> TSDB**.

Key settings:

- **Metric stores**: enable or disable each local store and set its recording
  interval.
- **Database**: set retention and recovery log checkpoint interval.
- **HTTP API**: enable the local Prometheus-compatible server and set the port
  or port range.
- **Scraping**: add external Prometheus exposition targets.
- **Advanced**: set the metric prefix and clear the committed recovery log.

The HTTP server is disabled by default. Local recording and note charting do
not require it.

## Advanced: Prometheus Interop

TSDB can both expose a Prometheus-compatible server and scrape Prometheus
endpoints. These features are optional and use local HTTP by default.

### Expose a Prometheus server

Enable **Serve metrics over HTTP** in settings to bind a local server. The
default port range is `9090-9099`, so several vaults can run at the same time.

Available endpoints:

| Endpoint | Notes |
| --- | --- |
| `/metrics` | Prometheus text exposition for current in-process metrics |
| `/health` and `/-/healthy` | Health checks |
| `/api/v1/query` | Instant queries with `query` and optional `time` |
| `/api/v1/query_range` | Range queries with `query`, `start`, `end`, and `step` |
| `/api/v1/series` | Series discovery with `match[]` selectors |
| `/api/v1/labels` | Label name discovery |
| `/api/v1/label/<name>/values` | Label value discovery |
| `/api/v1/status/buildinfo` | Build information |
| `/api/v1/status/tsdb` | Local TSDB status |
| `/api/v1/export` | JSON-lines export |

Grafana can use TSDB as a Prometheus datasource by pointing it at the bound
base URL, for example `http://localhost:9090`.

Because the server can bind any port in the configured range, TSDB also exposes
a Chrome DevTools Protocol helper:

```js
window.__tsdb?.getInfo();
// { vault, vaultId, pluginVersion, serverRunning, port, metricsPath, baseUrl }
```

The same helper exposes `getStats()`, `getScrapeStatuses()`, `query(expr)`, and
`queryRange(expr, startMs, endMs, stepMs)` for local tooling and tests.

### Scrape Prometheus endpoints

Add scrape jobs in settings with one or more target URLs, such as:

```text
http://localhost:9100/metrics
```

Each target is scraped into the local database. TSDB adds Prometheus-style
`job` and `instance` labels, preserves colliding target labels as
`exported_job` and `exported_instance`, and records synthetic scrape health
series:

- `up`
- `scrape_duration_seconds`
- `scrape_samples_scraped`

External scraping is useful when you want Obsidian to keep a local history of a
nearby app, development service, or machine exporter without running a separate
Prometheus instance.

## Project Structure

```text
tsdb/
+-- src/
|   +-- main.ts              # Plugin lifecycle and wiring
|   +-- settings.ts          # Settings model and defaults
|   +-- labels.ts            # Label sets and matchers
|   +-- types.ts             # Public metric API types
|   +-- exporter/            # prom-client registry, public API, built-ins
|   +-- scrape/              # Exposition parser and scrape scheduler
|   +-- storage/             # wa-sqlite TSDB, chunked VFS, recovery WAL
|   +-- promql/              # PromQL AST, parser, and engine
|   +-- panels/              # Markdown panel config and rendering data
|   +-- api/                 # HTTP server and /api/v1 routes
|   +-- ui/                  # Settings, modal, and dashboard view
+-- tests/                   # Vitest suites
+-- obsidian-metrics.d.ts    # Public type declarations
+-- manifest.json            # Plugin manifest
+-- package.json             # npm scripts and dependencies
```

## Development

```bash
npm install
npm run build
npm run dev
npm test
```

Release checks:

```bash
npm run release
```

`main.js` is a generated release artifact and is ignored by git. Build it before
manual installation or release packaging.

## License

MIT License
