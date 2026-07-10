import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "node_modules", "wa-sqlite", "dist");
const factoryPath = path.join(dist, "wa-sqlite-async.mjs");
const wasmPath = path.join(dist, "wa-sqlite-async.wasm");

const { default: createModule } = await import(pathToFileURL(factoryPath).href);
const module = await createModule({ wasmBinary: fs.readFileSync(wasmPath) });
const result = module.ccall(
	"sqlite3_tsdb_auto_extension",
	"number",
	[],
	[]
);
if (result !== 0) {
	throw new Error(`sqlite-tsdb registration failed: ${result}`);
}
console.log("sqlite-tsdb Wasm artifact verified");
