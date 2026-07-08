// esbuild's "binary" loader turns .wasm imports into a Uint8Array.
declare module "*.wasm" {
	const content: Uint8Array;
	export default content;
}
