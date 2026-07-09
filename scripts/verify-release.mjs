import { existsSync, readFileSync, statSync } from "fs";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

let failed = false;

function check(condition, message) {
	if (!condition) {
		console.error(`release check failed: ${message}`);
		failed = true;
	}
}

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");

check(manifest.id === "tsdb", 'manifest id must be "tsdb"');
check(
	manifest.name === "Time Series Database",
	'manifest name must be "Time Series Database"'
);
check(
	manifest.name !== manifest.name.toUpperCase(),
	"manifest name must not be all caps"
);
check(
	/[.!?]$/.test(manifest.description),
	"manifest description must end with punctuation"
);
check(!/\bobsidian\b/i.test(manifest.id), "manifest id must not include Obsidian");
check(!/\bobsidian\b/i.test(manifest.name), "manifest name must not include Obsidian");
check(
	manifest.version === packageJson.version,
	"manifest version must match package version"
);
check(
	versions[manifest.version] === manifest.minAppVersion,
	"versions.json must map manifest version to minAppVersion"
);

for (const path of ["main.js", "manifest.json"]) {
	check(existsSync(path), `${path} must exist`);
	if (existsSync(path)) {
		check(statSync(path).size > 0, `${path} must not be empty`);
	}
}

if (existsSync("styles.css")) {
	check(statSync("styles.css").size > 0, "styles.css must not be empty");
}

if (failed) {
	process.exit(1);
}

console.log(
	`release artifacts verified for ${manifest.id} ${manifest.version}`
);
