/**
 * zzz CLI configuration.
 *
 * Manages CLI-specific configuration stored at ~/.zzz/config.json.
 *
 * The CLI config uses the `zzz_config_` prefix for all fields to make
 * the source self-documenting in code.
 *
 * @module
 */

import {z} from 'zod';

import type {ZzzRuntime} from './runtime/types.ts';
import {log} from './cli/util.ts';

/**
 * Default port for the zzz daemon.
 */
export const ZZZ_DEFAULT_PORT = 4460;

/**
 * Schema for ~/.zzz/config.json.
 *
 * Uses `zzz_config_` prefix so field names are self-documenting:
 * ```typescript
 * const { zzz_config_port } = load_zzz_cli_config();
 * // Variable name tells you exactly what this is and where it came from
 * ```
 */
export const ZzzCliConfig = z.strictObject({
	/** Port for the zzz daemon. */
	zzz_config_port: z.number().default(ZZZ_DEFAULT_PORT),
});

export type ZzzCliConfig = z.infer<typeof ZzzCliConfig>;

/**
 * Get the CLI config directory path (~/.zzz).
 *
 * @param runtime - Runtime with env_get capability.
 * @returns Path to config directory, or null if $HOME is not set.
 */
export const get_zzz_dir = (runtime: Pick<ZzzRuntime, 'env_get'>): string | null => {
	const home = runtime.env_get('HOME');
	return home ? `${home}/.zzz` : null;
};

/**
 * Get the CLI config file path (~/.zzz/config.json).
 *
 * @param runtime - Runtime with env_get capability.
 * @returns Path to config.json, or null if $HOME is not set.
 */
export const get_zzz_config_path = (runtime: Pick<ZzzRuntime, 'env_get'>): string | null => {
	const zzz_dir = get_zzz_dir(runtime);
	return zzz_dir ? `${zzz_dir}/config.json` : null;
};

/**
 * Get the daemon info file path (~/.zzz/run/daemon.json).
 *
 * @param runtime - Runtime with env_get capability.
 * @returns Path to daemon.json, or null if $HOME is not set.
 */
export const get_zzz_daemon_info_path = (runtime: Pick<ZzzRuntime, 'env_get'>): string | null => {
	const zzz_dir = get_zzz_dir(runtime);
	return zzz_dir ? `${zzz_dir}/run/daemon.json` : null;
};

/**
 * Load CLI configuration from ~/.zzz/config.json.
 *
 * @param runtime - Runtime with file read capability.
 * @returns Parsed config, or null if file doesn't exist or is invalid.
 */
export const load_zzz_cli_config = async (
	runtime: Pick<ZzzRuntime, 'env_get' | 'read_file' | 'stat'>,
): Promise<ZzzCliConfig | null> => {
	const config_path = get_zzz_config_path(runtime);
	if (!config_path) {
		return null;
	}

	// Check if file exists
	const stat = await runtime.stat(config_path);
	if (!stat) {
		return null;
	}

	try {
		const content = await runtime.read_file(config_path);
		const parsed = JSON.parse(content);
		const result = ZzzCliConfig.safeParse(parsed);
		if (!result.success) {
			log.warn(`Invalid config.json: ${result.error.message}`);
			return null;
		}
		return result.data;
	} catch (error) {
		log.warn(`Failed to read config.json: ${(error as Error).message}`);
		return null;
	}
};

/**
 * Save CLI configuration to ~/.zzz/config.json.
 *
 * @param runtime - Runtime with file write capability.
 * @param config - Configuration to save.
 */
export const save_zzz_cli_config = async (
	runtime: Pick<ZzzRuntime, 'env_get' | 'write_file' | 'mkdir'>,
	config: ZzzCliConfig,
): Promise<void> => {
	const zzz_dir = get_zzz_dir(runtime);
	if (!zzz_dir) {
		throw new Error('$HOME not set');
	}

	const config_path = `${zzz_dir}/config.json`;

	// Ensure directory exists
	await runtime.mkdir(zzz_dir, {recursive: true});

	// Write with pretty formatting
	const content = JSON.stringify(config, null, '\t');
	await runtime.write_file(config_path, content + '\n');
};

/**
 * Daemon info schema for ~/.zzz/run/daemon.json.
 */
export const ZzzDaemonInfo = z.strictObject({
	/** Schema version. */
	version: z.number(),
	/** Server process ID. */
	pid: z.number(),
	/** Port the server is listening on. */
	port: z.number(),
	/** ISO timestamp when server started. */
	started: z.string(),
	/** Package version of zzz. */
	zzz_version: z.string(),
});

export type ZzzDaemonInfo = z.infer<typeof ZzzDaemonInfo>;

/**
 * Parse daemon info JSON with schema validation.
 *
 * @returns Parsed daemon info, or null if invalid.
 */
export const parse_daemon_info = (content: string): ZzzDaemonInfo | null => {
	try {
		const parsed = JSON.parse(content);
		const result = ZzzDaemonInfo.safeParse(parsed);
		if (!result.success) {
			log.warn(`Invalid daemon.json: ${result.error.message}`);
			return null;
		}
		return result.data;
	} catch {
		log.warn('Failed to parse daemon.json');
		return null;
	}
};
