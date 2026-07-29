import { readFileSync } from "fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const MAIN_PATH = "src/main.ts";

function methodInFile(path: string, name: string): ts.MethodDeclaration {
	const source = readFileSync(path, "utf8");
	const file = ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	for (const statement of file.statements) {
		if (!ts.isClassDeclaration(statement)) continue;
		for (const member of statement.members) {
			if (
				ts.isMethodDeclaration(member) &&
				ts.isIdentifier(member.name) &&
				member.name.text === name
			) {
				return member;
			}
		}
	}
	throw new Error(`Could not find ${name} in ${path}`);
}

function pluginMethod(name: string): ts.MethodDeclaration {
	return methodInFile(MAIN_PATH, name);
}

describe("plugin startup lifecycle", () => {
	it("keeps onload synchronous and queues runtime work for layout ready", () => {
		const onload = pluginMethod("onload");
		const text = onload.getText();
		const isAsync = onload.modifiers?.some(
			(modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword
		);

		expect(isAsync).not.toBe(true);
		expect(text).toContain("this.registerUi()");
		expect(text).toContain("this.app.workspace.onLayoutReady");
		expect(text).toContain("this.startRuntimeInitialization()");
		expect(text).not.toContain("openMetricsStore");
		expect(text).not.toContain("loadSettings");
	});

	it("keeps expensive startup in the deferred runtime initializer", () => {
		const text = pluginMethod("initializeRuntime").getText();

		expect(text).toContain("await this.loadSettings()");
		expect(text).toContain("await this.openMetricsStore");
		expect(text).toContain("setupVaultMetrics");
		expect(text).toContain("this.restartScraper()");
		expect(text).not.toContain("this.pruneOldSamples()");
		expect(text).toContain('this.app.workspace.trigger("tsdb:ready"');
	});

	it("closes the store queue before checkpointing tracked ingests", () => {
		const text = pluginMethod("teardown").getText();
		const closeStore = text.indexOf("await this.store?.close()");
		const waitForIngests = text.indexOf("await this.waitForInFlightIngests()");
		const flushWal = text.indexOf("await this.flushStore()");

		expect(closeStore).toBeGreaterThan(-1);
		expect(waitForIngests).toBeGreaterThan(closeStore);
		expect(flushWal).toBeGreaterThan(waitForIngests);
	});

	it("leaves embedded Wasm encoded during module evaluation", () => {
		const config = readFileSync("esbuild.config.mjs", "utf8");

		expect(config).toContain('".wasm": "base64"');
		expect(config).not.toContain('".wasm": "binary"');
	});

	it("does not compact historical data while opening the store", () => {
		const text = methodInFile("src/storage/store.ts", "init").getText();

		expect(text).not.toContain("await this.compactBefore");
		expect(text).not.toContain("nextCompaction");
	});

	it("runs compaction as delayed, interleaved maintenance", () => {
		const config = readFileSync("src/storage/compaction.ts", "utf8");
		const timers = pluginMethod("restartMaintenanceTimers").getText();
		const sweep = pluginMethod("runCompactionSweep").getText();
		const ingest = methodInFile(
			"src/storage/store.ts",
			"ingestLocked"
		).getText();

		expect(timers).toContain(
			"this.scheduleCompaction(STARTUP_COMPACTION_DELAY_MS)"
		);
		expect(sweep).toContain("store.compactBeforeBatch");
		expect(sweep).toContain("this.compactionPointLimit");
		expect(sweep).toContain("nextCompactionPointLimit");
		expect(sweep).toContain("COMPACTION_BATCH_PAUSE_MS");
		expect(config).toContain("COMPACTION_BATCH_MAX_POINTS = 512");
		expect(config).toContain("COMPACTION_BACKLOG_RETRY_MS = 1000");
		expect(ingest).not.toContain("compactBefore");
	});

	it("moves only one bounded hot slice per compaction transaction", () => {
		const source = readFileSync("sqlite-tsdb/src/sqlite_tsdb.c", "utf8");
		const start = source.indexOf("static int compact_before");
		const end = source.indexOf("static int delete_before", start);
		const text = source.slice(start, end);

		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		expect(text).toContain("compact_hot_slice");
		expect(text).toContain("compact_overlapping_block");
		expect(text).not.toContain("while (");
	});

	it("selects compaction work without grouping the hot table", () => {
		const source = readFileSync("sqlite-tsdb/src/sqlite_tsdb.c", "utf8");
		const start = source.indexOf("static int find_oldest_compactable_bucket");
		const end = source.indexOf("static int compact_before", start);
		const text = source.slice(start, end);

		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		expect(text).toContain('INDEXED BY \\"%w_ts\\"');
		expect(text).toContain("ORDER BY ts,series_id LIMIT 1");
		expect(text).not.toContain("GROUP BY");
	});

	it("does not scan all retained samples to maintain retention metadata", () => {
		const deletion = methodInFile(
			"src/storage/store.ts",
			"deleteBeforeLocked"
		).getText();
		const bounds = methodInFile(
			"src/storage/store.ts",
			"refreshKnownSampleBounds"
		).getText();
		const series = methodInFile(
			"src/storage/store.ts",
			"pruneEmptySeriesLocked"
		).getText();

		expect(deletion).not.toContain(
			"SELECT count(*) FROM samples WHERE ts < ?"
		);
		expect(deletion).toContain("collectRetentionCounts");
		expect(bounds).toContain("samples_head");
		expect(bounds).toContain("samples_blocks");
		expect(series).toContain("NOT EXISTS");
		expect(series).toContain("samples_head.series_id = series.id");
		expect(series).toContain("samples_blocks.series_id = series.id");
	});

	it("runs retention as interleaved bounded batches", () => {
		const config = readFileSync("src/storage/retention.ts", "utf8");
		const text = pluginMethod("runRetentionSweep").getText();

		expect(text).toContain("store.deleteBeforeBatch");
		expect(text).toContain("RETENTION_BATCH_MAX_SAMPLES");
		expect(text).toContain("RETENTION_BATCH_PAUSE_MS");
		expect(text).toContain("recordRetention");
		expect(config).toContain("RETENTION_BATCH_MAX_SAMPLES = 2_048");
		expect(config).toContain("RETENTION_BATCH_PAUSE_MS = 250");
	});

	it("exits a retention no-op before transaction and vacuum work", () => {
		const text = methodInFile(
			"src/storage/store.ts",
			"deleteBeforeBatchLocked"
		).getText();

		expect(text).toContain("if (!hasExpiredHead)");
		expect(text.indexOf("if (!hasExpiredHead)")).toBeLessThan(
			text.indexOf('this.db, "BEGIN"')
		);
	});
});
