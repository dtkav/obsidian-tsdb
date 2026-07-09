/**
 * Minimal typings for the Node builtins this plugin reaches at runtime.
 *
 * Obsidian loads plugins inside an Electron renderer, which exposes Node's
 * CommonJS `require` and the `http`/`https`/`url` modules. The plugin reviewer,
 * however, type-checks with Node's ambient types absent, so importing these
 * modules or naming `Buffer`/`NodeJS` would degrade to the intrinsic `error`
 * type. Declaring only the surface actually used — with real types — keeps the
 * code type-correct both with and without @types/node.
 */

declare global {
	/**
	 * CommonJS module loader. The Electron renderer that hosts plugins (and the
	 * test runner) provide it at runtime; declared here so Node builtins can be
	 * required without depending on @types/node. Returns `unknown` so callers
	 * assert the concrete module shape, keeping the result away from `any`.
	 */
	function require(id: string): unknown;
}

/** A Node system error: an Error carrying an errno string like "EADDRINUSE". */
export type ErrnoError = Error & { code?: string };

/** An in-flight HTTP request, as returned by http.get / https.get. */
export interface ClientRequest {
	on(event: "timeout", listener: () => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	destroy(error?: Error): void;
}

/**
 * An incoming HTTP message: a server request while handling a connection, or a
 * client response while scraping a target.
 */
export interface IncomingMessage {
	method?: string;
	url?: string;
	statusCode?: number;
	headers: Record<string, string | undefined>;
	setEncoding(encoding: string): void;
	resume(): void;
	on(event: "data", listener: (chunk: string) => void): void;
	on(event: "end", listener: () => void): void;
	on(event: "error", listener: (error: Error) => void): void;
}

/** The subset of a server response the API handlers write to. */
export interface ServerResponse {
	setHeader(name: string, value: string): void;
	writeHead(statusCode: number, headers?: Record<string, string>): void;
	write(chunk: string): void;
	end(chunk?: string): void;
}

/** A connected socket, tracked so it can be force-closed on shutdown. */
export interface Socket {
	on(event: "close", listener: () => void): void;
	destroy(): void;
}

/** An HTTP server bound to a local port. */
export interface Server {
	listening: boolean;
	on(event: "connection", listener: (socket: Socket) => void): void;
	once(event: "error", listener: (error: ErrnoError) => void): void;
	listen(port: number, host: string, listener: () => void): void;
	close(callback: () => void): void;
	removeAllListeners(): void;
}

/**
 * The http module surface used here. https is structurally identical for our
 * needs (only get), so one type covers both and the protocol is chosen at
 * runtime.
 */
export interface HttpModule {
	createServer(
		listener: (req: IncomingMessage, res: ServerResponse) => void
	): Server;
	get(
		url: URL | string,
		options: { timeout?: number },
		callback: (res: IncomingMessage) => void
	): ClientRequest;
}

/** The url module surface: the WHATWG URL classes, matching the DOM globals. */
export interface UrlModule {
	URL: typeof URL;
	URLSearchParams: typeof URLSearchParams;
}
