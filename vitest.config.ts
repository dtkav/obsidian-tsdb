import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		{
			// Mirror esbuild's `loader: { ".wasm": "base64" }` for tests that
			// import the plugin entry point.
			name: "wasm-as-base64",
			enforce: "pre",
			load(id) {
				const path = id.split("?")[0];
				if (path.endsWith(".wasm")) {
					return (
						`import { readFileSync } from "fs";\n` +
						`export default readFileSync(${JSON.stringify(path)}).toString("base64");`
					);
				}
			},
		},
	],
	test: {
		environment: "node",
		setupFiles: ["./tests/setup.ts"],
	},
});
