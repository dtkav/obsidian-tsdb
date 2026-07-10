if (typeof window === "undefined") {
	Object.defineProperty(globalThis, "window", {
		value: globalThis,
		configurable: true,
	});
}

export {};
