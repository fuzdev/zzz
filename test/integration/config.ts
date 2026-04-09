/**
 * Backend configurations for integration tests.
 *
 * Each backend defines how to start/stop it and which endpoints to hit.
 */

export interface BackendConfig {
	readonly name: string;
	readonly start_command: readonly string[];
	readonly base_url: string;
	readonly rpc_path: string;
	readonly ws_path: string;
	readonly health_path: string;
	readonly startup_timeout_ms: number;
	/** Extra env vars merged into the child process environment. */
	readonly env?: Readonly<Record<string, string>>;
}

export const backends: Record<string, BackendConfig> = {
	deno: {
		name: 'deno',
		start_command: ['deno', 'task', 'dev:start'],
		base_url: 'http://localhost:4460',
		rpc_path: '/api/rpc',
		ws_path: '/ws',
		health_path: '/health',
		startup_timeout_ms: 15_000,
		// Override port so .env.development values don't conflict with test expectations.
		// Deno's --env flag won't override vars already in the process environment.
		env: {PUBLIC_SERVER_PROXIED_PORT: '4460'},
	},
	rust: {
		name: 'rust',
		start_command: ['cargo', 'run', '-p', 'zzz_server', '--', '--port', '1174'],
		base_url: 'http://localhost:1174',
		rpc_path: '/rpc',
		ws_path: '/ws',
		health_path: '/health',
		startup_timeout_ms: 60_000, // includes compile time on first run
	},
};
