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
import type {EnvDeps, FsReadDeps, FsWriteDeps} from '@fuzdev/fuz_app/runtime/deps.js';
import {
	get_app_dir,
	get_config_path,
	load_config,
	save_config,
} from '@fuzdev/fuz_app/cli/config.js';
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
export const ZzzCliOptions = z.strictObject({
	/** Port for the zzz daemon. */
	zzz_config_port: z.number().default(ZZZ_DEFAULT_PORT),
});

export type ZzzCliOptions = z.infer<typeof ZzzCliOptions>;

/**
 * Get the CLI config directory path (~/.zzz).
 *
 * @param runtime - runtime with env_get capability
 * @returns path to config directory, or null if $HOME is not set
 */
export const get_zzz_dir = (runtime: Pick<EnvDeps, 'env_get'>): string | null =>
	get_app_dir(runtime, 'zzz');

/**
 * Get the CLI config file path (~/.zzz/config.json).
 *
 * @param runtime - runtime with env_get capability
 * @returns path to config.json, or null if $HOME is not set
 */
export const get_zzz_config_path = (runtime: Pick<EnvDeps, 'env_get'>): string | null =>
	get_config_path(runtime, 'zzz');

/**
 * Load CLI configuration from ~/.zzz/config.json.
 *
 * @param runtime - runtime with file read capability
 * @returns parsed config, or null if file doesn't exist or is invalid
 */
export const load_zzz_cli_config = async (
	runtime: Pick<EnvDeps, 'env_get'> & FsReadDeps,
): Promise<ZzzCliOptions | null> => {
	const config_path = get_zzz_config_path(runtime);
	if (!config_path) return null;
	return load_config(runtime, config_path, ZzzCliOptions);
};

/**
 * Save CLI configuration to ~/.zzz/config.json.
 *
 * @param runtime - runtime with file write capability
 * @param config - configuration to save
 */
export const save_zzz_cli_config = async (
	runtime: Pick<EnvDeps, 'env_get'> & FsWriteDeps,
	config: ZzzCliOptions,
): Promise<void> => {
	const zzz_dir = get_zzz_dir(runtime);
	if (!zzz_dir) throw new Error('$HOME not set');
	const config_path = `${zzz_dir}/config.json`;
	return save_config(runtime, config_path, zzz_dir, config);
};
