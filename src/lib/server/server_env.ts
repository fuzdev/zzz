/**
 * Server environment configuration.
 *
 * Extends `BaseServerEnv` from fuz_app with zzz-specific fields.
 * Uses `load_env` from fuz_app for schema-validated loading.
 *
 * @module
 */

import {z} from 'zod';
import {BaseServerEnv} from '@fuzdev/fuz_app/server/env.js';
import {load_env, EnvValidationError, log_env_validation_error} from '@fuzdev/fuz_app/env/load.js';

/**
 * Zod schema for zzz server environment variables.
 *
 * Extends `BaseServerEnv` with zzz-specific fields for app data,
 * scoped directories, AI provider API keys, and testing configuration.
 */
export const ZzzServerEnv = BaseServerEnv.extend({
	PUBLIC_ZZZ_DIR: z.string().default('.zzz').meta({description: 'Zzz app data directory'}),
	PUBLIC_ZZZ_SCOPED_DIRS: z
		.string()
		.default('')
		.meta({description: 'Comma-separated filesystem paths the server can access'}),
	PUBLIC_BACKEND_ARTIFICIAL_RESPONSE_DELAY: z.coerce
		.number()
		.default(0)
		.meta({description: 'Artificial response delay in ms (testing)'}),
	SECRET_ANTHROPIC_API_KEY: z
		.string()
		.optional()
		.meta({description: 'Anthropic API key for Claude provider', sensitivity: 'secret'}),
	SECRET_OPENAI_API_KEY: z
		.string()
		.optional()
		.meta({description: 'OpenAI API key for ChatGPT provider', sensitivity: 'secret'}),
	SECRET_GOOGLE_API_KEY: z
		.string()
		.optional()
		.meta({description: 'Google API key for Gemini provider', sensitivity: 'secret'}),
});
export type ZzzServerEnv = z.infer<typeof ZzzServerEnv>;

/**
 * Parsed server env with derived values ready for use.
 *
 * Separates raw env loading from the derived shapes callers need
 * (e.g., `scoped_dirs` as an array, `port` as a number).
 */
export interface ZzzServerConfig {
	/** Full validated env object. */
	env: ZzzServerEnv;
	/** Zzz app data directory (e.g., `.zzz` or `~/.zzz/`). */
	zzz_dir: string;
	/** Filesystem paths the server can access for user files. */
	scoped_dirs: Array<string>;
	/** Port for the Hono backend server. */
	port: number;
	/** Hostname for the server. */
	host: string;
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
 * Parse a comma-separated string into an array, trimming whitespace.
 *
 * @returns array of non-empty strings
 */
const parse_comma_separated = (value: string): Array<string> => {
	if (!value) return [];
	return value
		.split(',')
		.map((p) => p.trim())
		.filter(Boolean);
};

/**
 * Load and validate server env, then derive the config callers need.
 *
 * Uses `load_env` from fuz_app for Zod-validated loading.
 * The `overrides` parameter lets CLI flags and startup defaults
 * take precedence over env vars.
 *
 * @param get_env - function to read environment variables
 * @param overrides - values that take precedence over env vars
 */
export const load_server_env = (
	get_env: (key: string) => string | undefined,
	overrides?: Partial<ZzzServerConfig>,
): ZzzServerConfig => {
	let raw: ZzzServerEnv;
	try {
		raw = load_env(ZzzServerEnv, get_env);
	} catch (err) {
		if (err instanceof EnvValidationError) {
			log_env_validation_error(err, 'zzz');
			throw err;
		}
		throw err;
	}

	return {
		env: raw,
		zzz_dir: overrides?.zzz_dir ?? raw.PUBLIC_ZZZ_DIR,
		scoped_dirs: overrides?.scoped_dirs ?? parse_comma_separated(raw.PUBLIC_ZZZ_SCOPED_DIRS),
		port: overrides?.port ?? raw.PORT,
		host: overrides?.host ?? raw.HOST,
		websocket_path: overrides?.websocket_path ?? '/api/ws',
		api_path: overrides?.api_path ?? '/api/rpc',
		artificial_delay: overrides?.artificial_delay ?? raw.PUBLIC_BACKEND_ARTIFICIAL_RESPONSE_DELAY,
		app_version: overrides?.app_version ?? '0.0.1',
		secret_anthropic_api_key: overrides?.secret_anthropic_api_key ?? raw.SECRET_ANTHROPIC_API_KEY,
		secret_openai_api_key: overrides?.secret_openai_api_key ?? raw.SECRET_OPENAI_API_KEY,
		secret_google_api_key: overrides?.secret_google_api_key ?? raw.SECRET_GOOGLE_API_KEY,
	};
};
