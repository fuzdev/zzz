/**
 * zzz init command.
 *
 * Initialize zzz configuration (~/.zzz/).
 *
 * @module
 */

import type {ZzzRuntime} from '../runtime/types.ts';
import {colors, log} from '../cli/util.ts';
import type {InitArgs} from '../cli/schemas.ts';
import type {ZzzGlobalArgs} from '../cli/cli_args.ts';
import {
	get_zzz_dir,
	get_zzz_config_path,
	save_zzz_cli_config,
	ZZZ_DEFAULT_PORT,
} from '../cli_config.ts';

/**
 * Initialize zzz configuration (~/.zzz/).
 *
 * Creates the config directory and config.json.
 */
export const cmd_init = async (
	runtime: ZzzRuntime,
	args: InitArgs,
	_flags: ZzzGlobalArgs,
): Promise<void> => {
	const config_path = get_zzz_config_path(runtime);
	if (!config_path) {
		log.error('$HOME not set');
		runtime.exit(1);
	}

	// Check if already initialized
	const existing = await runtime.stat(config_path);
	if (existing) {
		log.warn(`${config_path} already exists`);
		console.log(`\nTo reinitialize, delete ${colors.cyan}~/.zzz/config.json${colors.reset} first`);
		runtime.exit(1);
	}

	const port = args.port ?? ZZZ_DEFAULT_PORT;

	// Create directory structure
	const zzz_dir = get_zzz_dir(runtime)!;
	await runtime.mkdir(`${zzz_dir}/state/db`, {recursive: true});
	await runtime.mkdir(`${zzz_dir}/run`, {recursive: true});
	await runtime.mkdir(`${zzz_dir}/cache`, {recursive: true});

	// Create config.json
	await save_zzz_cli_config(runtime, {zzz_config_port: port});
	log.info(`Created ${config_path}`);

	console.log(
		`\nzzz is ready. Run ${colors.cyan}zzz daemon start${colors.reset} to start the daemon.`,
	);
	console.log(`Or just run ${colors.cyan}zzz${colors.reset} to auto-start and open the browser.`);
};
