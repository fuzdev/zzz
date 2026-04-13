/**
 * Dev orchestration script — Rust backend + Vite frontend.
 *
 * Builds zzz_server, starts it with env from .env.development,
 * then starts the Vite dev server with the proxy pointed at
 * the Rust backend. Ctrl+C kills both.
 *
 * Usage: deno task dev
 *
 * @module
 */

import {load_env_file} from '@fuzdev/fuz_app/env/dotenv.js';

import {runtime, set_permissions} from './setup_helpers.ts';

const RUST_BACKEND_PORT = 8999;
const ENV_FILE = '.env.development';

// -- Load environment ---------------------------------------------------------

console.log(`[dev] loading ${ENV_FILE}`);
const env = await load_env_file(runtime, ENV_FILE);
if (!env) {
	console.error(`[dev] FATAL: ${ENV_FILE} not found — run: deno task dev:setup`);
	Deno.exit(1);
}

// -- Ensure bootstrap token exists --------------------------------------------

const token_path = env.BOOTSTRAP_TOKEN_PATH;
if (token_path) {
	try {
		await Deno.stat(token_path);
	} catch {
		// Create directory and token file
		const dir = token_path.includes('/') ? token_path.substring(0, token_path.lastIndexOf('/')) : '.';
		await Deno.mkdir(dir, {recursive: true});
		const token_bytes = new Uint8Array(32);
		crypto.getRandomValues(token_bytes);
		const token = Array.from(token_bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		await Deno.writeTextFile(token_path, token);
		await set_permissions(token_path, 0o600);
		console.log(`[dev] created bootstrap token at ${token_path}`);
	}
}

// Override port so the Rust backend binds to the same port the Vite proxy expects.
// The Vite proxy reads PUBLIC_SERVER_PROXIED_PORT from the process env.
env.PORT = String(RUST_BACKEND_PORT);
env.PUBLIC_SERVER_PROXIED_PORT = String(RUST_BACKEND_PORT);
env.PUBLIC_WEBSOCKET_URL = `ws://localhost:${RUST_BACKEND_PORT}/api/ws`;

// Build the merged env for child processes.
const child_env: Record<string, string> = {};
for (const [key, value] of Object.entries(Deno.env.toObject())) {
	child_env[key] = value;
}
for (const [key, value] of Object.entries(env)) {
	child_env[key] = value;
}

// -- Build Rust backend -------------------------------------------------------

console.log('[dev] building zzz_server...');
const build = new Deno.Command('cargo', {
	args: ['build', '-p', 'zzz_server'],
	stdout: 'inherit',
	stderr: 'inherit',
});

const build_result = await build.output();
if (!build_result.success) {
	console.error('[dev] FATAL: cargo build failed');
	Deno.exit(1);
}
console.log('[dev] build complete');

// -- Start Rust backend -------------------------------------------------------

console.log(`[dev] starting zzz_server on port ${RUST_BACKEND_PORT}...`);
const server_process = new Deno.Command('./target/debug/zzz_server', {
	args: ['--port', String(RUST_BACKEND_PORT)],
	env: child_env,
	stdout: 'inherit',
	stderr: 'inherit',
}).spawn();

// Wait for health check
const health_url = `http://localhost:${RUST_BACKEND_PORT}/health`;
const health_timeout_ms = 30_000;
const health_start = Date.now();
let healthy = false;

while (Date.now() - health_start < health_timeout_ms) {
	try {
		const res = await fetch(health_url);
		if (res.ok) {
			healthy = true;
			break;
		}
	} catch {
		// not ready yet
	}
	await new Promise((r) => setTimeout(r, 200));
}

if (!healthy) {
	console.error(`[dev] FATAL: zzz_server did not become healthy within ${health_timeout_ms}ms`);
	server_process.kill('SIGTERM');
	Deno.exit(1);
}
console.log('[dev] zzz_server healthy');

// -- Start Vite dev server ----------------------------------------------------

console.log('[dev] starting vite dev server...');
const vite_process = new Deno.Command('npx', {
	args: ['vite', 'dev'],
	env: child_env,
	stdout: 'inherit',
	stderr: 'inherit',
}).spawn();

// -- Shutdown handling --------------------------------------------------------

let shutting_down = false;

const shutdown = (): void => {
	if (shutting_down) return;
	shutting_down = true;
	console.log('\n[dev] shutting down...');
	try {
		vite_process.kill('SIGTERM');
	} catch {
		// already dead
	}
	try {
		server_process.kill('SIGTERM');
	} catch {
		// already dead
	}
};

Deno.addSignalListener('SIGINT', shutdown);
Deno.addSignalListener('SIGTERM', shutdown);

// Wait for either process to exit, then tear down the other.
const server_status = server_process.status;
const vite_status = vite_process.status;

const first_exit = await Promise.race([
	server_status.then((s) => ({who: 'zzz_server', status: s})),
	vite_status.then((s) => ({who: 'vite', status: s})),
]);

if (!shutting_down) {
	console.log(`[dev] ${first_exit.who} exited (code ${first_exit.status.code}), shutting down...`);
	shutdown();
}

// Wait for remaining process.
await Promise.allSettled([server_status, vite_status]);
console.log('[dev] done');
