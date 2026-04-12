/**
 * Backend configurations for integration tests.
 *
 * Each backend defines how to start/stop it and which endpoints to hit.
 */

export interface AuthConfig {
	/** Path to the bootstrap endpoint. */
	readonly bootstrap_path: string;
	/** Token value to write to the token file and send in the bootstrap request. */
	readonly token: string;
	/** Filesystem path where the token file is written before server start. */
	readonly token_file: string;
	/** Username for the bootstrapped admin account. */
	readonly username: string;
	/** Password for the bootstrapped admin account. */
	readonly password: string;
}

/** Account management route paths (differ between backends). */
export interface AccountPaths {
	readonly login: string;
	readonly logout: string;
	readonly password: string;
	readonly sessions: string;
	/** Template with `:id` placeholder for session revocation. */
	readonly session_revoke: string;
}

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
	/** Auth setup — if present, the runner bootstraps an admin account before tests. */
	readonly auth?: AuthConfig;
	/** Account management route paths (differ between backends). */
	readonly account_paths?: AccountPaths;
}

const INTEGRATION_BOOTSTRAP_TOKEN = 'zzz-integration-test-token';
const INTEGRATION_TOKEN_FILE = '/tmp/zzz_integration_bootstrap_token';

/** Scoped filesystem directory for filesystem integration tests. */
export const INTEGRATION_SCOPED_DIR = '/tmp/zzz_integration_scoped';

/** Test database URL — defaults to postgres://localhost/zzz_test. */
export const TEST_DATABASE_URL =
	Deno.env.get('TEST_DATABASE_URL') ?? 'postgres://localhost/zzz_test';

export const backends: Record<string, BackendConfig> = {
	deno: {
		name: 'deno',
		start_command: ['deno', 'task', 'dev:start'],
		base_url: 'http://localhost:4460',
		rpc_path: '/api/rpc',
		ws_path: '/api/ws',
		health_path: '/health',
		startup_timeout_ms: 15_000,
		// Override port so .env.development values don't conflict with test expectations.
		// PORT is the server bind var (BaseServerEnv); PUBLIC_SERVER_PROXIED_PORT
		// is the SvelteKit frontend var. Both need to agree.
		env: {
			PORT: '4460',
			PUBLIC_SERVER_PROXIED_PORT: '4460',
			BOOTSTRAP_TOKEN_PATH: INTEGRATION_TOKEN_FILE,
			DATABASE_URL: TEST_DATABASE_URL,
			SECRET_COOKIE_KEYS: 'integration-test-cookie-key-min-32-chars',
			ALLOWED_ORIGINS: 'http://localhost:*',
			PUBLIC_ZZZ_SCOPED_DIRS: INTEGRATION_SCOPED_DIR,
		},
		auth: {
			bootstrap_path: '/api/account/bootstrap',
			token: INTEGRATION_BOOTSTRAP_TOKEN,
			token_file: INTEGRATION_TOKEN_FILE,
			username: 'testadmin',
			password: 'test-password-integration-123',
		},
		account_paths: {
			login: '/api/account/login',
			logout: '/api/account/logout',
			password: '/api/account/password',
			sessions: '/api/account/sessions',
			session_revoke: '/api/account/sessions/:id/revoke',
		},
	},
	rust: {
		name: 'rust',
		start_command: ['cargo', 'run', '-p', 'zzz_server', '--', '--port', '1174'],
		base_url: 'http://localhost:1174',
		rpc_path: '/rpc',
		ws_path: '/ws',
		health_path: '/health',
		startup_timeout_ms: 60_000, // includes compile time on first run
		env: {
			DATABASE_URL: TEST_DATABASE_URL,
			SECRET_COOKIE_KEYS: 'integration-test-cookie-key-min-32-chars',
			BOOTSTRAP_TOKEN_PATH: INTEGRATION_TOKEN_FILE,
			ALLOWED_ORIGINS: 'http://localhost:*',
			PUBLIC_ZZZ_SCOPED_DIRS: INTEGRATION_SCOPED_DIR,
		},
		auth: {
			bootstrap_path: '/bootstrap',
			token: INTEGRATION_BOOTSTRAP_TOKEN,
			token_file: INTEGRATION_TOKEN_FILE,
			username: 'testadmin',
			password: 'test-password-integration-123',
		},
		account_paths: {
			login: '/login',
			logout: '/logout',
			password: '/password',
			sessions: '/sessions',
			session_revoke: '/sessions/:id/revoke',
		},
	},
};
