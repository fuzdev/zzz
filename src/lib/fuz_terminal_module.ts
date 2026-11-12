/**
 * Loads the terminal emulator's compiled wasm module — libghostty-vt, which
 * `FuzTerminal` instantiates once per view — from the app's static assets:
 * fetched and compiled once per page, the same promise handed to every view.
 *
 * The module isn't committed: `cargo xtask ghostty-vt` builds it into
 * `static/fuz_terminal/ghostty-vt.wasm`, so a checkout or build without it
 * serves a 404 (or, from a server with an SPA fallback, an HTML page). Either
 * rejects with a message saying how to build it, which a view shows as its
 * `failed` state. So does a load that doesn't finish within
 * `FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS` — that's what ends a load that would
 * never finish: the view fails, the output it held is released (and the
 * terminal paced again), and its retry is offered. A failed load isn't kept:
 * the next view to mount, or a retry, tries again.
 *
 * @module
 */

import { asset } from '$app/paths';
import type { AssetPath } from '$app/types';

/** The module's path among the static assets, where `cargo xtask ghostty-vt` installs it. */
export const FUZ_TERMINAL_MODULE_ASSET = 'fuz_terminal/ghostty-vt.wasm';

/** What to do when the module isn't there, for the messages a failed load carries. */
const BUILD_HINT = 'build it with `cargo xtask ghostty-vt` (needs Zig 0.17)';

/**
 * How long fetching and compiling the module may take before the load fails,
 * in milliseconds. A view holds the output it's handed until its module
 * loads, so a load that never settles must end.
 */
export const FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS = 30_000;

/** The first four bytes of every wasm binary. */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

/** What loading the module takes: fetching it and compiling it, and a timer to bound both. */
export interface FuzTerminalModuleDeps {
	/** The module's URL. */
	url: string;
	/** Fetch `url`, aborted through `signal` when the load times out. */
	fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
	/** Compile from a response served as `application/wasm`; absent where the platform lacks it. */
	compile_streaming?: (response: Response) => Promise<WebAssembly.Module>;
	compile: (bytes: Uint8Array<ArrayBuffer>) => Promise<WebAssembly.Module>;
	/** Run `callback` once after `ms` milliseconds, returning an id `clear_timeout` takes. */
	set_timeout: (callback: () => void, ms: number) => unknown;
	clear_timeout: (id: unknown) => void;
	/** The bound on the load; defaults to `FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS`. */
	timeout_ms?: number;
}

/**
 * Fetch and compile the module once. Compiles while it downloads when the
 * response is served as `application/wasm`, and from the bytes otherwise (a
 * server that sends another type isn't an error). Rejects, with a message
 * naming the URL and saying how to build the module, when the response isn't
 * ok (a 404 for a module that was never built), isn't wasm (an HTML fallback
 * page), or the fetch or compile fails — or when the whole load hasn't
 * settled within `timeout_ms`, aborting the fetch (a compile in progress
 * can't be stopped; its result is dropped).
 */
export const fetch_fuz_terminal_module = (
	deps: FuzTerminalModuleDeps
): Promise<WebAssembly.Module> =>
	new Promise((resolve, reject) => {
		const timeout_ms = deps.timeout_ms ?? FUZ_TERMINAL_MODULE_LOAD_TIMEOUT_MS;
		const controller = new AbortController();
		let settled = false;
		const timer = deps.set_timeout(() => {
			if (settled) return;
			settled = true;
			controller.abort();
			reject(
				new Error(
					`the terminal emulator module didn't load within ${Math.round(timeout_ms / 1000)}s (${deps.url}) — if it isn't built, ${BUILD_HINT}`
				)
			);
		}, timeout_ms);
		load_module(deps, controller.signal).then(
			(module) => {
				if (settled) return;
				settled = true;
				deps.clear_timeout(timer);
				resolve(module);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				deps.clear_timeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		);
	});

/** The load itself, unbounded: fetch, check, compile. */
const load_module = async (
	deps: FuzTerminalModuleDeps,
	signal: AbortSignal
): Promise<WebAssembly.Module> => {
	const { url } = deps;
	let response: Response;
	try {
		response = await deps.fetch(url, { signal });
	} catch (error) {
		throw new Error(
			`couldn't fetch the terminal emulator module ${url}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}
	if (!response.ok) {
		throw new Error(
			`the terminal emulator module isn't available (${url} answered ${response.status}) — ${BUILD_HINT}`
		);
	}
	const content_type = response.headers.get('content-type');
	const media_type = content_type?.split(';')[0]!.trim().toLowerCase();
	if (media_type === 'application/wasm' && deps.compile_streaming) {
		return deps.compile_streaming(response);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (!WASM_MAGIC.every((byte, i) => bytes[i] === byte)) {
		throw new Error(
			`the terminal emulator module isn't available (${url} isn't a wasm module${content_type ? `: it's ${content_type}` : ''}) — ${BUILD_HINT}`
		);
	}
	return deps.compile(bytes);
};

/**
 * A loader that shares one load among its callers: every call while a load is
 * in flight or after it succeeded gets the same promise; a load that failed is
 * dropped once it settles, so the next call starts a new one.
 */
export const create_fuz_terminal_module_loader = (
	deps: () => FuzTerminalModuleDeps
): (() => Promise<WebAssembly.Module>) => {
	let loading: Promise<WebAssembly.Module> | null = null;
	return () => {
		if (loading) return loading;
		const load = fetch_fuz_terminal_module(deps());
		loading = load;
		load.catch(() => {
			if (loading === load) loading = null;
		});
		return load;
	};
};

/**
 * An asset's URL. `AssetPath` lists the files `static/` held when the types
 * were generated — this one only in a checkout that built it — so the path is
 * taken as any string.
 */
const to_asset_url = (file: string): string => asset(file as AssetPath);

/**
 * The page's module: fetched from the app's static assets with the browser's
 * `fetch` and `WebAssembly`, once, on the first call (never on the server).
 */
export const load_fuz_terminal_module = create_fuz_terminal_module_loader(() => ({
	url: to_asset_url(FUZ_TERMINAL_MODULE_ASSET),
	fetch: (url, init) => fetch(url, init),
	compile_streaming:
		typeof WebAssembly.compileStreaming === 'function'
			? (response) => WebAssembly.compileStreaming(response)
			: undefined,
	compile: (bytes) => WebAssembly.compile(bytes),
	set_timeout: (callback, ms) => setTimeout(callback, ms),
	clear_timeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
}));
