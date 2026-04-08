/**
 * Server environment configuration.
 *
 * Env loading for the zzz Deno server. Reads from `Deno.env.get` with
 * configurable defaults, replacing `$env/static/*` imports.
 *
 * @module
 */

/**
 * Server environment values needed to create a zzz app.
 */
export interface ZzzServerEnv {
	/** Zzz app data directory (e.g., `.zzz` or `~/.zzz/`). */
	zzz_dir: string;
	/** Filesystem paths the server can access for user files. */
	scoped_dirs: Array<string>;
	/** Port for the Hono backend server. */
	port: number;
	/** Hostname for the server. */
	host: string;
	/** Comma-separated origin patterns for request verification. */
	allowed_origins: string;
	/** WebSocket endpoint path. */
	websocket_path: string;
	/** HTTP RPC endpoint path. */
	api_path: string;
	/** Artificial response delay in ms (testing). */
	artificial_delay: number;
	/** Package version string. */
	app_version: string;
	/** Anthropic API key for Claude provider. */
	secret_anthropic_api_key: string | undefined;
	/** OpenAI API key for ChatGPT provider. */
	secret_openai_api_key: string | undefined;
	/** Google API key for Gemini provider. */
	secret_google_api_key: string | undefined;
}

/**
 * Load server env from a generic env reader function.
 *
 * Works with `process.env`, `Deno.env.get`, or any `(key) => string | undefined`.
 * Defaults can override missing env values.
 *
 * @param env_get - function to read environment variables
 * @param defaults - override defaults for any field
 */
export const load_server_env = (
	env_get: (key: string) => string | undefined,
	defaults?: Partial<ZzzServerEnv>,
): ZzzServerEnv => {
	return {
		zzz_dir: env_get('PUBLIC_ZZZ_DIR') || defaults?.zzz_dir || '.zzz',
		scoped_dirs:
			parse_comma_separated(env_get('PUBLIC_ZZZ_SCOPED_DIRS')) ?? defaults?.scoped_dirs ?? [],
		port: parseInt(env_get('PUBLIC_SERVER_PROXIED_PORT') ?? '', 10) || defaults?.port || 4460,
		host: env_get('PUBLIC_SERVER_HOST') || defaults?.host || 'localhost',
		allowed_origins:
			env_get('ALLOWED_ORIGINS') || defaults?.allowed_origins || 'http://localhost:*',
		websocket_path: defaults?.websocket_path || '/ws',
		api_path: defaults?.api_path || '/api/rpc',
		artificial_delay:
			parseInt(env_get('PUBLIC_BACKEND_ARTIFICIAL_RESPONSE_DELAY') ?? '', 10) ||
			defaults?.artificial_delay ||
			0,
		app_version: defaults?.app_version || '0.0.1',
		secret_anthropic_api_key:
			env_get('SECRET_ANTHROPIC_API_KEY') || defaults?.secret_anthropic_api_key,
		secret_openai_api_key: env_get('SECRET_OPENAI_API_KEY') || defaults?.secret_openai_api_key,
		secret_google_api_key: env_get('SECRET_GOOGLE_API_KEY') || defaults?.secret_google_api_key,
	};
};

/**
 * Parse a comma-separated string into an array, trimming whitespace.
 *
 * @returns array of non-empty strings, or null if input is empty/undefined
 */
const parse_comma_separated = (value: string | undefined): Array<string> | null => {
	if (!value) return null;
	const parts = value
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);
	return parts.length > 0 ? parts : null;
};
