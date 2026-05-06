/**
 * Shared helpers for integration tests.
 *
 * Assertion utilities, HTTP/WebSocket helpers, crypto helpers,
 * and common types used across test modules.
 */

import {type BackendConfig, TEST_DATABASE_URL} from './config.ts';
// @ts-ignore — npm specifier, resolved at runtime by Deno
import {hash as blake3_hash} from 'npm:@fuzdev/blake3_wasm';
// @ts-ignore — npm specifier, resolved at runtime by Deno
import {to_hex} from 'npm:@fuzdev/fuz_util/hex.js';

// -- Crypto helpers -----------------------------------------------------------

/**
 * HMAC-SHA256 sign a value.
 *
 * Returns `{value}.{base64(signature)}` — same format as auth.rs `Keyring::sign`
 * and fuz_app's `sign_with_crypto_key`.
 */
export const hmac_sign = async (value: string, key_str: string): Promise<string> => {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(key_str),
		{name: 'HMAC', hash: 'SHA-256'},
		false,
		['sign'],
	);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
	const sig_b64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return `${value}.${sig_b64}`;
};

/**
 * Hash a raw token with blake3 and hex-encode the digest. Matches what the
 * server stores in `auth_session.id` and `api_token.token_hash`.
 */
export const hash_token = (token: string): string =>
	to_hex(blake3_hash(new TextEncoder().encode(token)));

// -- SQL helpers --------------------------------------------------------------

/**
 * Escape a string for safe SQL single-quote interpolation.
 *
 * Doubles single quotes per the SQL standard. Use at every `'${...}'`
 * interpolation site when building SQL for psql.
 */
export const sql_escape = (value: string): string => value.replaceAll("'", "''");

/**
 * Run SQL via `psql` against the test database. Returns `{ok: true}` on
 * success or `{ok: false, stderr}` on failure. Callers pick their own error
 * policy (throw / warn / ignore specific errors / fire-and-forget).
 */
export const run_psql = async (
	sql: string,
): Promise<{ok: true} | {ok: false; stderr: string}> => {
	const cmd = new Deno.Command('psql', {
		args: [TEST_DATABASE_URL, '-c', sql],
		stdout: 'null',
		stderr: 'piped',
	});
	const child = cmd.spawn();
	const status = await child.status;
	if (status.success) {
		await child.stderr.cancel();
		return {ok: true};
	}
	const stderr = (await new Response(child.stderr).text()).trim();
	return {ok: false, stderr};
};

/**
 * Create a dedicated session for the bootstrapped `testadmin` account via
 * psql, and return the token hash plus the signed session cookie. Used by
 * tests that exercise session revocation and cookie-vs-bearer priority.
 *
 * Sets both `fuz_session` (Rust) and `zzz_session` (Deno) cookie names so
 * the same cookie works against either backend.
 */
export const create_testadmin_session = async (
	config: BackendConfig,
	token: string,
): Promise<{token_hash: string; cookie: string}> => {
	const token_hash = hash_token(token);
	const result = await run_psql(`
		INSERT INTO auth_session (id, account_id, expires_at)
		SELECT '${sql_escape(token_hash)}', id, NOW() + INTERVAL '30 days'
		FROM account WHERE username = 'testadmin'
		ON CONFLICT DO NOTHING;
	`);
	if (!result.ok) throw new Error(`create_testadmin_session: ${result.stderr}`);

	const expires_at = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
	const cookie_key = config.env?.SECRET_COOKIE_KEYS;
	if (!cookie_key) throw new Error('SECRET_COOKIE_KEYS not configured');
	const cookie_value = await hmac_sign(`${token}:${expires_at}`, cookie_key);
	const cookie = `fuz_session=${cookie_value}; zzz_session=${cookie_value}`;

	return {token_hash, cookie};
};

// -- URL helpers --------------------------------------------------------------

export const rpc_url = (config: BackendConfig): string => `${config.base_url}${config.rpc_path}`;
export const ws_url = (config: BackendConfig): string => {
	const url = new URL(config.ws_path, config.base_url);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.href;
};

// -- HTTP helpers -------------------------------------------------------------

/** POST a raw string body to the RPC endpoint. */
export const post_rpc = async (
	config: BackendConfig,
	body: string,
	options?: {cookie?: string; bearer?: string},
): Promise<{status: number; body: unknown}> => {
	const headers: Record<string, string> = {'Content-Type': 'application/json'};
	if (options?.cookie) headers.Cookie = options.cookie;
	if (options?.bearer !== undefined) headers.Authorization = `Bearer ${options.bearer}`;
	const res = await fetch(rpc_url(config), {
		method: 'POST',
		headers,
		body,
	});
	const json = await res.json();
	return {status: res.status, body: json};
};

// -- WebSocket helpers --------------------------------------------------------

/** Persistent WebSocket connection handle for multi-message tests. */
export interface WsConnection {
	send(message: string): void;
	receive(timeout_ms?: number): Promise<unknown>;
	expect_silence(timeout_ms?: number): Promise<void>;
	close(): void;
	/** Resolve with the close event once the server tears down the socket. */
	wait_closed(timeout_ms?: number): Promise<{code: number; reason: string}>;
}

/** Open a WebSocket connection, resolves once connected. */
export const open_ws = (
	config: BackendConfig,
	options?: {cookie?: string; bearer?: string; ignore_methods?: ReadonlyArray<string>},
): Promise<WsConnection> =>
	new Promise((resolve, reject) => {
		const ws_headers: Record<string, string> = {};
		if (options?.cookie) ws_headers.Cookie = options.cookie;
		if (options?.bearer !== undefined) ws_headers.Authorization = `Bearer ${options.bearer}`;
		const ws_options = Object.keys(ws_headers).length > 0 ? {headers: ws_headers} : undefined;
		const ws = new WebSocket(ws_url(config), ws_options as unknown as string[]);
		const pending: Array<{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			silent: boolean;
		}> = [];
		// Buffer of messages received with no pending waiter. Cross-connection
		// ordering (WS vs HTTP) means a server broadcast can arrive at the WS
		// socket before the test code awaits `receive()` — without a buffer,
		// those messages would be silently dropped and tests would time out.
		const buffer: Array<unknown> = [];
		// Methods to silently drop before they hit the buffer or any waiter.
		// Broadcasts are shared across all WS connections on the server, so
		// unrelated notifications (e.g. `filer_change` debounced events from
		// prior tests' filesystem writes) can leak onto a freshly opened
		// connection and skew assertions that expect a specific notification.
		// `filer_change` is the primary offender because its 80ms debounce
		// routinely outlives the test that triggered it — default-ignore it.
		// Tests that specifically assert on filer_change override by passing
		// an explicit `ignore_methods` list.
		const ignore = new Set(options?.ignore_methods ?? ['filer_change']);

		// Captured at close time — `wait_closed` reads or awaits it.
		let close_info: {code: number; reason: string} | null = null;
		const close_waiters: Array<{
			resolve: (value: {code: number; reason: string}) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}> = [];

		ws.onmessage = (event) => {
			const data = JSON.parse(String(event.data));
			const method = (data as {method?: unknown}).method;
			if (typeof method === 'string' && ignore.has(method)) return;
			const waiter = pending.shift();
			if (!waiter) {
				buffer.push(data);
				return;
			}
			clearTimeout(waiter.timer);
			if (waiter.silent) {
				waiter.reject(new Error(`expected no response, got: ${JSON.stringify(data)}`));
			} else {
				waiter.resolve(data);
			}
		};

		ws.onerror = () => {
			const err = new Error('WebSocket error');
			if (pending.length > 0) {
				const waiter = pending.shift()!;
				clearTimeout(waiter.timer);
				waiter.reject(err);
			} else {
				reject(err);
			}
		};

		ws.onopen = () =>
			resolve({
				send: (message) => ws.send(message),
				receive: (timeout_ms = 5_000) =>
					new Promise((res, rej) => {
						if (buffer.length > 0) {
							res(buffer.shift());
							return;
						}
						const timer = setTimeout(() => {
							pending.shift();
							rej(new Error('WebSocket response timeout'));
						}, timeout_ms);
						pending.push({resolve: res, reject: rej, timer, silent: false});
					}),
				expect_silence: (timeout_ms = 1_000) =>
					new Promise<void>((res, rej) => {
						if (buffer.length > 0) {
							rej(new Error(`expected no response, got: ${JSON.stringify(buffer.shift())}`));
							return;
						}
						const timer = setTimeout(() => {
							pending.shift();
							res();
						}, timeout_ms);
						pending.push({
							// silent waiters never receive a value — cast to satisfy the shared pending shape
							resolve: res as (value: unknown) => void,
							reject: rej,
							timer,
							silent: true,
						});
					}),
				close: () => ws.close(),
				wait_closed: (timeout_ms = 5_000) =>
					new Promise((res, rej) => {
						if (close_info) {
							res(close_info);
							return;
						}
						const timer = setTimeout(() => {
							const idx = close_waiters.findIndex((w) => w.timer === timer);
							if (idx >= 0) close_waiters.splice(idx, 1);
							rej(new Error('WebSocket did not close in time'));
						}, timeout_ms);
						close_waiters.push({resolve: res, reject: rej, timer});
					}),
			});

		// Handle both connection-time rejection (401 at upgrade) and
		// post-open close events that tests need to observe (e.g. revocation).
		ws.onclose = (event) => {
			close_info = {code: event.code, reason: event.reason};
			for (const waiter of close_waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.resolve(close_info);
			}
			if (event.code !== 1000 && ws.readyState === WebSocket.CLOSED) {
				// If we never finished connecting, reject the outer promise.
				// After onopen fired, onopen's resolve has already run — reject
				// here is a no-op on a settled promise.
				const err = new Error(`WebSocket closed: code=${event.code} reason=${event.reason}`);
				reject(err);
			}
		};
	});

/**
 * Ensure a WebSocket connection is fully registered on the server.
 *
 * After `open_ws` resolves (onopen), the server's `handle_connection` task
 * may not have called `add_connection` yet. A round-trip RPC proves the
 * connection loop is running and the connection is in `app.connections`.
 */
export const ensure_ws_registered = async (conn: WsConnection): Promise<void> => {
	conn.send(JSON.stringify({jsonrpc: '2.0', id: '_warmup', method: 'ping'}));
	await conn.receive();
};

// -- Assertion helpers --------------------------------------------------------

export const assert_equal = (actual: unknown, expected: unknown, label: string): void => {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
};

/** Recursively sort object keys so key order doesn't affect comparison. */
export const sort_keys = (v: unknown): unknown => {
	if (v === null || typeof v !== 'object') return v;
	if (Array.isArray(v)) return v.map(sort_keys);
	const sorted: Record<string, unknown> = {};
	for (const k of Object.keys(v as Record<string, unknown>).sort()) {
		sorted[k] = sort_keys((v as Record<string, unknown>)[k]);
	}
	return sorted;
};

/** Exact deep equality (key-order-independent). */
export const assert_deep_equal = (actual: unknown, expected: unknown, label: string): void => {
	const a = JSON.stringify(sort_keys(actual));
	const e = JSON.stringify(sort_keys(expected));
	if (a !== e) {
		throw new Error(`${label}\n  expected: ${e}\n  actual:   ${a}`);
	}
};
