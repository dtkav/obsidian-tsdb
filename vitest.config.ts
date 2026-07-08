import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		{
			// Mirror esbuild's `loader: { ".wasm": "binary" }` so imports of
			// sql.js's wasm binary work under vitest too.
			name: "wasm-as-binary",
			enforce: "pre",
			load(id) {
				const path = id.split("?")[0];
				if (path.endsWith(".wasm")) {
					return (
						`import { readFileSync } from "fs";\n` +
						`export default new Uint8Array(readFileSync(${JSON.stringify(path)}));`
					);
				}
			},
		},
	],
	test: {
		environment: "node",
	},
});
