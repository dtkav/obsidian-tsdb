import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const [factoryPath, wasmPath, apiPath] = process.argv.slice(2);
if (!factoryPath || !wasmPath || !apiPath) {
	throw new Error(
		"usage: node bench/wasm_benchmark.mjs FACTORY.mjs SQLITE.wasm sqlite-api.js"
	);
}

const { default: createModule } = await import(
	pathToFileURL(path.resolve(factoryPath)).href
);
const SQLite = await import(pathToFileURL(path.resolve(apiPath)).href);
const wasmBinary = fs.readFileSync(wasmPath);
const module = await createModule({ wasmBinary });
const registerRc = module.ccall(
	"sqlite3_tsdb_auto_extension",
	"number",
	[],
	[]
);
if (registerRc !== 0) throw new Error(`sqlite-tsdb registration failed: ${registerRc}`);

const sqlite3 = SQLite.Factory(module);
const seriesCount = Number(process.env.SERIES_COUNT ?? 50);
const pointsPerSeries = Number(process.env.POINTS_PER_SERIES ?? 720);
const stepMs = Number(process.env.STEP_MS ?? 30_000);
const startMs = 1_700_000_000_000;
const querySeries = Array.from(
	{ length: Math.min(10, seriesCount) },
	(_, index) => index + 1
);

function elapsed(started) {
	return performance.now() - started;
}

function valueFor(seriesId, pointIndex) {
	return seriesId * 0.125 + Math.sin(pointIndex / 20) * 10 + pointIndex / 1000;
}

function encodeBatch(pointIndex) {
	const bytes = new Uint8Array(16 + seriesCount * 24);
	bytes.set([0x54, 0x53, 0x49, 0x31]);
	const view = new DataView(bytes.buffer);
	view.setUint16(4, 1, true);
	view.setUint16(6, 24, true);
	view.setUint32(8, seriesCount, true);
	view.setUint32(12, 0, true);
	const timestamp = startMs + pointIndex * stepMs;
	for (let index = 0; index < seriesCount; index++) {
		const offset = 16 + index * 24;
		const seriesId = index + 1;
		view.setBigInt64(offset, BigInt(seriesId), true);
		view.setBigInt64(offset + 8, BigInt(timestamp), true);
		view.setFloat64(offset + 16, valueFor(seriesId, pointIndex), true);
	}
	return bytes;
}

async function prepare(db, sql) {
	const sqlString = sqlite3.str_new(db, sql);
	try {
		const prepared = await sqlite3.prepare_v2(db, sqlite3.str_value(sqlString));
		if (!prepared) throw new Error(`statement did not compile: ${sql}`);
		return prepared.stmt;
	} finally {
		sqlite3.str_finish(sqlString);
	}
}

async function runStatement(stmt, bindings) {
	sqlite3.bind_collection(stmt, bindings);
	const result = await sqlite3.step(stmt);
	if (result !== SQLite.SQLITE_DONE) {
		throw new Error(`expected SQLITE_DONE, received ${result}`);
	}
	await sqlite3.reset(stmt);
}

async function scalar(db, sql) {
	let value = null;
	await sqlite3.exec(db, sql, (row) => {
		value = row[0];
	});
	return value;
}

async function databaseSize(db) {
	const pageCount = Number(await scalar(db, "PRAGMA page_count"));
	const pageSize = Number(await scalar(db, "PRAGMA page_size"));
	return pageCount * pageSize;
}

async function benchmarkBaseline() {
	const db = await sqlite3.open_v2(":memory:");
	await sqlite3.exec(
		db,
		"CREATE TABLE samples(series_id INTEGER NOT NULL,ts INTEGER NOT NULL,value REAL NOT NULL,PRIMARY KEY(series_id,ts)) WITHOUT ROWID; CREATE INDEX idx_samples_ts ON samples(ts);"
	);
	const insert = await prepare(
		db,
		"INSERT INTO samples(series_id,ts,value) VALUES(?1,?2,?3)"
	);
	const started = performance.now();
	for (let pointIndex = 0; pointIndex < pointsPerSeries; pointIndex++) {
		await sqlite3.exec(db, "BEGIN");
		const timestamp = startMs + pointIndex * stepMs;
		for (let seriesId = 1; seriesId <= seriesCount; seriesId++) {
			await runStatement(insert, [
				seriesId,
				timestamp,
				valueFor(seriesId, pointIndex),
			]);
		}
		await sqlite3.exec(db, "COMMIT");
	}
	const ingestMs = elapsed(started);
	await sqlite3.finalize(insert);
	const sizeBytes = await databaseSize(db);

	let selectedRows = 0;
	const queryStart = startMs + Math.floor(pointsPerSeries / 2) * stepMs;
	const queryEnd = startMs + pointsPerSeries * stepMs;
	const selected = querySeries.join(",");
	const queryStarted = performance.now();
	await sqlite3.exec(
		db,
		`SELECT series_id,ts,value FROM samples WHERE series_id IN (${selected}) AND ts BETWEEN ${queryStart} AND ${queryEnd} ORDER BY series_id,ts`,
		() => selectedRows++
	);
	const queryMs = elapsed(queryStarted);

	const retentionStarted = performance.now();
	await sqlite3.exec(db, `DELETE FROM samples WHERE ts<${queryStart}`);
	const retentionMs = elapsed(retentionStarted);
	await sqlite3.close(db);
	return { ingestMs, queryMs, retentionMs, selectedRows, sizeBytes };
}

async function benchmarkTsdb() {
	const db = await sqlite3.open_v2(":memory:");
	await sqlite3.exec(
		db,
		"CREATE VIRTUAL TABLE samples USING tsdb(block_span_ms=21600000,max_block_points=2048)"
	);
	const insert = await prepare(
		db,
		"INSERT INTO samples(control,arg1,arg2) VALUES('ingest-batch',?1,1)"
	);
	const started = performance.now();
	for (let pointIndex = 0; pointIndex < pointsPerSeries; pointIndex++) {
		await sqlite3.exec(db, "BEGIN");
		await runStatement(insert, [encodeBatch(pointIndex)]);
		await sqlite3.exec(db, "COMMIT");
	}
	const ingestMs = elapsed(started);
	await sqlite3.finalize(insert);

	const compactCutoff = startMs + pointsPerSeries * stepMs + 21_600_000;
	const compactStarted = performance.now();
	await sqlite3.exec(
		db,
		`INSERT INTO samples(control,arg1,arg2) VALUES('compact-before',${compactCutoff},1000000)`
	);
	const compactMs = elapsed(compactStarted);
	const sizeBytes = await databaseSize(db);

	let selectedRows = 0;
	const queryStart = startMs + Math.floor(pointsPerSeries / 2) * stepMs;
	const queryEnd = startMs + pointsPerSeries * stepMs;
	const selected = querySeries.join(",");
	const queryStarted = performance.now();
	await sqlite3.exec(
		db,
		`SELECT series_id,ts,value FROM samples WHERE series_id IN (${selected}) AND ts BETWEEN ${queryStart} AND ${queryEnd} ORDER BY series_id,ts`,
		() => selectedRows++
	);
	const queryMs = elapsed(queryStarted);

	let packedSeries = 0;
	const packedStarted = performance.now();
	await sqlite3.exec(
		db,
		`SELECT series_id,tsdb_pack(ts,value) FROM samples WHERE series_id IN (${selected}) AND ts BETWEEN ${queryStart} AND ${queryEnd} GROUP BY series_id`,
		() => packedSeries++
	);
	const packedQueryMs = elapsed(packedStarted);

	const retentionStarted = performance.now();
	await sqlite3.exec(
		db,
		`INSERT INTO samples(control,arg1) VALUES('delete-before',${queryStart})`
	);
	const retentionMs = elapsed(retentionStarted);
	await sqlite3.close(db);
	return {
		ingestMs,
		compactMs,
		queryMs,
		packedQueryMs,
		retentionMs,
		selectedRows,
		packedSeries,
		sizeBytes,
	};
}

const baseline = await benchmarkBaseline();
const tsdb = await benchmarkTsdb();
console.log(
	JSON.stringify(
		{
			runtime: { node: process.version, wasmBytes: wasmBinary.byteLength },
			workload: {
				seriesCount,
				pointsPerSeries,
				samples: seriesCount * pointsPerSeries,
				stepMs,
			},
			baseline,
			tsdb,
			ratios: {
				ingest: tsdb.ingestMs / baseline.ingestMs,
				query: tsdb.queryMs / baseline.queryMs,
				retention: tsdb.retentionMs / baseline.retentionMs,
				size: tsdb.sizeBytes / baseline.sizeBytes,
			},
		},
		null,
		2
	)
);
