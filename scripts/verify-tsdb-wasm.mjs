import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "node_modules", "wa-sqlite", "dist");
const SQLite = await import("wa-sqlite");
for (const artifact of ["wa-sqlite", "wa-sqlite-async"]) {
	const factoryPath = path.join(dist, `${artifact}.mjs`);
	const wasmPath = path.join(dist, `${artifact}.wasm`);
	const { default: createModule } = await import(
		pathToFileURL(factoryPath).href
	);
	const module = await createModule({ wasmBinary: fs.readFileSync(wasmPath) });
	const result = module.ccall(
		"sqlite3_tsdb_auto_extension",
		"number",
		[],
		[]
	);
	if (result !== 0) {
		throw new Error(`${artifact} sqlite-tsdb registration failed: ${result}`);
	}
	const sqlite3 = SQLite.Factory(module);
	const db = await sqlite3.open_v2(":memory:");
	try {
		await sqlite3.exec(
			db,
			"CREATE VIRTUAL TABLE samples USING tsdb;" +
				"INSERT INTO samples(series_id,ts,value) VALUES(1,1000,42.5)"
		);
		let stored = null;
		await sqlite3.exec(db, "SELECT value FROM samples", (row) => {
			stored = row[0];
		});
		if (stored !== 42.5) {
			throw new Error(`${artifact} sqlite-tsdb query smoke test failed`);
		}
	} finally {
		await sqlite3.close(db);
	}
}
console.log("sqlite-tsdb sync and async Wasm artifacts verified");
