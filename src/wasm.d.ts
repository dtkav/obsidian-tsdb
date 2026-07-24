// esbuild's "base64" loader keeps .wasm imports encoded until runtime startup.
declare module "*.wasm" {
	const content: string;
	export default content;
}
