# TSDB

An Obsidian plugin that turns your vault into a self-contained metrics station: it exposes metrics in Prometheus format, **scrapes and stores them in a local SQLite time-series database**, and serves a **Prometheus-compatible query API** (a subset of PromQL) that Grafana can use directly as a Prometheus datasource.

## Features

- **Prometheus Server**: Built-in HTTP server serving metrics in Prometheus format
- **Metrics Scraper**: Periodically scrapes its own metrics and any external Prometheus exposition endpoints (e.g. node_exporter) into a local store
- **Local TSDB**: Time series stored in SQLite (wa-sqlite/WASM, bundled — no native modules) through a custom VFS that writes 64 KiB chunk files via Obsidian's vault adapter, so every scrape is durable on commit and no Node file APIs are needed for storage
- **Query API**: Prometheus-compatible `/api/v1/*` endpoints with a PromQL subset — point Grafana at `http://localhost:9090` as a Prometheus datasource
- **TypeScript API**: Full-featured API for creating and managing metrics
- **Multiple Metric Types**: Support for Counters, Gauges, Histograms, and Summaries
- **Built-in Metrics**: Automatic collection of system and plugin metrics
- **Default Labels**: All metrics automatically include `vault_name` and `vault_id` labels
- **Plugin Integration**: Event-based API for other plugins with proper load order handling
- **Settings Interface**: Configurable server, scraping, and storage options

## Installation

### Manual Installation

1. Clone this repository into your `.obsidian/plugins/` folder:
   ```bash
   cd /path/to/your/vault/.obsidian/plugins/
   git clone https://github.com/yourusername/obsidian-tsdb.git
   ```

2. Install dependencies and build:
   ```bash
   cd obsidian-tsdb
   npm install
   npm run build
   ```

3. Enable the plugin in Obsidian Settings -> Community Plugins

## Usage

### Basic Setup

Once installed, the plugin will:
- Start a Prometheus server on port 9090 (configurable)
- Expose metrics at `http://localhost:9090/metrics`
- Add a status indicator to the status bar
- Provide a ribbon icon for quick access

### API for Other Plugins

#### Type Definitions

Copy `obsidian-metrics.d.ts` into your plugin for type-safe API access. This file contains:
- All interface definitions (`IObsidianMetricsAPI`, `MetricInstance`, etc.)
- Module augmentation for the `tsdb:ready` workspace event
- Comprehensive usage documentation

#### Accessing the API

```typescript
import { IObsidianMetricsRootAPI, IObsidianMetricsAPI, MetricInstance, ObsidianMetricsPlugin } from './obsidian-metrics';

class MyPlugin extends Plugin {
  private metricsApi: IObsidianMetricsAPI | undefined;
  private myGauge: MetricInstance | undefined;

  async onload() {
    // Listen for metrics API becoming available (handles load order and reloads)
    this.registerEvent(
      this.app.workspace.on('tsdb:ready', (api: IObsidianMetricsRootAPI) => {
        this.initializeMetrics(api);
      })
    );

    // Also try to get it immediately in case metrics plugin loaded first
    const metricsPlugin = this.app.plugins.plugins['tsdb'] as ObsidianMetricsPlugin | undefined;
    if (metricsPlugin?.api) {
      this.initializeMetrics(metricsPlugin.api);
    }
  }

  private initializeMetrics(rootApi: IObsidianMetricsRootAPI) {
    const api = rootApi.getStore('my-plugin', {
      intervalSeconds: 30,
      displayName: 'My plugin metrics',
      description: 'Document size and activity metrics.',
    });
    this.metricsApi = api;

    // Metric creation is idempotent - safe to call multiple times
    this.myGauge = api.createGauge({
      name: 'my_document_size_bytes',
      help: 'Size of documents in bytes',
      labelNames: ['document']
    });
  }

  updateDocumentSize(doc: string, bytes: number) {
    this.myGauge?.labels({ document: doc }).set(bytes);
  }
}
```

#### Key Points

- **Do NOT cache the API or metrics long-term** - they become stale if TSDB reloads
- Listen for `tsdb:ready` and re-initialize your metrics each time it fires
- Metric creation is idempotent: calling `createGauge()` with the same name returns the existing metric
- All metrics automatically include `vault_name` and `vault_id` labels

### Creating Metrics

#### Counter (values that only increase)
```typescript
const pageViewCounter = api.createCounter({
  name: 'page_views_total',
  help: 'Total number of page views',
  labelNames: ['page_type', 'source']
});

// Increment
pageViewCounter.inc();
pageViewCounter.inc(5);
pageViewCounter.inc(1, { page_type: 'note', source: 'search' });

// Or use fluent labels() API
pageViewCounter.labels({ page_type: 'note', source: 'search' }).inc();
```

#### Gauge (values that can go up and down)
```typescript
const activeNotesGauge = api.createGauge({
  name: 'active_notes_count',
  help: 'Number of currently active notes'
});

// Set value
activeNotesGauge.set(42);
activeNotesGauge.inc();
activeNotesGauge.dec(5);

// With labels
activeNotesGauge.labels({ workspace: 'main' }).set(10);
```

#### Histogram (distribution of values in buckets)
```typescript
const loadTimeHistogram = api.createHistogram({
  name: 'page_load_duration_seconds',
  help: 'Page load duration in seconds',
  buckets: [0.1, 0.5, 1, 2, 5]
});

// Observe values
loadTimeHistogram.observe(1.2);
loadTimeHistogram.observe(0.8, { page_type: 'canvas' });

// Time operations
const timer = loadTimeHistogram.startTimer();
// ... do work ...
timer(); // Automatically observes the duration
```

#### Summary (quantiles over sliding time window)
```typescript
const responseSummary = api.createSummary({
  name: 'api_response_duration_seconds',
  help: 'API response duration in seconds',
  percentiles: [0.5, 0.9, 0.95, 0.99]
});

responseSummary.observe(0.234);
```

### Convenience Methods

```typescript
// Quick counter creation
const counter = api.counter('button_clicks', 'Button click count', 1);

// Quick gauge creation
const gauge = api.gauge('memory_usage', 'Memory usage in bytes', 1024);

// Quick histogram creation
const hist = api.histogram('request_duration', 'Request duration');
```

### Measuring Function Execution

```typescript
// Measure async functions
const result = await api.measureAsync('async_operation_duration', async () => {
  return await someAsyncOperation();
});

// Measure sync functions
const result = api.measureSync('sync_operation_duration', () => {
  return someCalculation();
});

// Manual timing
const timer = api.createTimer('custom_operation_duration');
// ... do work ...
const durationMs = timer(); // Returns duration in milliseconds
```

## Configuration

Access plugin settings through **Settings -> Community Plugins -> TSDB**

### Server Configuration
- **Enable Metrics Server**: Toggle the Prometheus server on/off
- **Server Port or Range**: A port (`9090`) or range (`9090-9099`, the default). With a range the first free port is bound, so several vaults can run the plugin concurrently.
- **Metrics Endpoint Path**: Configure the metrics endpoint (default: /metrics)

### Port discovery over CDP

Because the bound port is dynamic with a range, the plugin installs a CDP-accessible global (same convention as Relay's `window.__relayDebug`): attach to Obsidian over the Chrome DevTools Protocol, enumerate renderer targets, and evaluate in each:

```js
window.__tsdb?.getInfo()
// { vault, vaultId, pluginVersion, serverRunning, port, metricsPath, baseUrl }
```

The global also exposes `getStats()`, `getScrapeStatuses()`, and direct PromQL access via `query(expr)` / `queryRange(expr, startMs, endMs, stepMs)` — handy for E2E tests and external tooling without going through HTTP.

### Metrics Configuration
- **Enable Built-in Metrics**: Collect real Obsidian usage metrics
- **Custom Metrics Prefix**: Prefix for custom metrics (default: `obsidian_`)

## Built-in Metrics

When enabled, the plugin automatically collects:

### File Operations
- `obsidian_file_operations_total`: File operations with `operation` and `file_type` labels

### Vault Statistics
- `obsidian_vault_files_total`: Total files in vault
- `obsidian_vault_notes_total`: Total markdown notes
- `obsidian_vault_size_bytes`: Total vault size

### Application State
- `obsidian_active_notes_count`: Open notes/tabs
- `obsidian_plugins_enabled_total`: Enabled plugins
- `obsidian_note_view_duration_seconds`: Time viewing notes (histogram)

### Performance
- `obsidian_browser_memory_usage_bytes`: Browser memory usage
- `obsidian_app_performance_timing_seconds`: App operation timings (histogram)

All metrics include `vault_name` and `vault_id` labels automatically.

## Scraping & Local Storage

The plugin doubles as a miniature Prometheus-style metrics store:

- **Self-scrape**: its own registries are recorded into the local database on an interval (default 30s), under `job="vault"` and `job="performance"`.
- **External scrape jobs**: add jobs in settings with one or more target URLs (e.g. `http://localhost:9100/metrics` for node_exporter). Each scrape also records the synthetic `up`, `scrape_duration_seconds` and `scrape_samples_scraped` series, and `job`/`instance` labels are attached the way Prometheus does.
- **Storage & durability**: samples live in a real SQLite database (wa-sqlite, Asyncify build) whose files are stored as 64 KiB chunk files under `metrics-tsdb/` in the plugin folder, written through Obsidian's vault adapter via a custom SQLite VFS. Every scrape batch is one committed transaction — durable immediately, with SQLite's own journal providing crash recovery; a page write rewrites one chunk, never the whole database. A secondary write-ahead log (`metrics.wal`) acts as a recovery net: entries are appended after commit, replayed idempotently on startup, and truncated on an interval. A legacy sql.js `metrics.db` snapshot is migrated automatically on first load. Retention (default 30 days) is pruned hourly.

## Query API

All endpoints live on the same port as the metrics server and follow the Prometheus HTTP API envelope, so **Grafana works out of the box**: add a Prometheus datasource with URL `http://localhost:9090`.

| Endpoint | Notes |
|---|---|
| `/api/v1/query` | instant queries (`query`, `time`) |
| `/api/v1/query_range` | range queries (`query`, `start`, `end`, `step`) |
| `/api/v1/series` | `match[]` selectors |
| `/api/v1/labels`, `/api/v1/label/<name>/values` | label discovery |
| `/api/v1/status/buildinfo`, `/api/v1/status/tsdb` | status/feature probes |
| `/api/v1/export` | JSON-lines export |

### Supported PromQL subset

- Selectors with `=`, `!=`, `=~`, `!~` matchers, range selectors (`[5m]`), `offset`
- `rate`, `irate`, `increase`, `delta`, `idelta`, `changes`, `resets`, and `*_over_time` (avg/min/max/sum/count/last/present/stddev/stdvar/quantile)
- `histogram_quantile`, `abs`, `ceil`, `floor`, `round`, `sqrt`, `exp`, `ln`, `log2`, `log10`, `sgn`, `clamp`, `clamp_min`, `clamp_max`, `scalar`, `vector`, `time`, `absent`, `sort`, `sort_desc`
- Aggregations: `sum`, `avg`, `min`, `max`, `count`, `stddev`, `stdvar`, `quantile`, `topk`, `bottomk` with `by`/`without`
- Binary operators: arithmetic, comparisons (incl. `bool`), `and`/`or`/`unless`, one-to-one vector matching with `on`/`ignoring`

Not supported (yet): subqueries, `@` modifiers, `group_left`/`group_right`, `label_replace`/`label_join`. Unsupported constructs return a clear `400` error.

## Endpoints

### Metrics Endpoint
- **URL**: `http://localhost:9090/metrics`
- **Format**: Prometheus text format

### Health Check
- **URL**: `http://localhost:9090/health`
- **Response**: `{ "status": "ok", "timestamp": "...", "metrics_endpoint": "/metrics" }`

## Project Structure

```
tsdb/
├── src/
│   ├── main.ts              # Plugin lifecycle
│   ├── settings.ts          # Settings model + defaults
│   ├── labels.ts            # Label sets & matchers (shared)
│   ├── types.ts             # Public metric API types
│   ├── exporter/            # prom-client registry, public API, built-in metrics
│   ├── scrape/              # Exposition parser + scrape scheduler
│   ├── storage/             # SQLite (sql.js) time-series store
│   ├── promql/              # PromQL subset: AST, parser, engine
│   ├── api/                 # HTTP server + /api/v1 routes
│   └── ui/                  # Modal + settings tab
├── tests/                   # Vitest suites (parser, engine, store)
├── obsidian-metrics.d.ts    # Public type declarations (copy to your plugin)
├── manifest.json            # Plugin manifest
└── package.json             # Dependencies
```

## Development

```bash
npm install      # Install dependencies
npm run build    # Production build (typecheck + bundle)
npm run dev      # Development with watch mode
npm test         # Run the vitest suites
```

## License

MIT License
