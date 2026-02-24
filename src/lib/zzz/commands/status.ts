/**
 * zzz status command.
 *
 * Show current system state (daemon status, loaded workspaces, watched repos).
 *
 * @module
 */

import {colors, log} from '@fuzdev/fuz_app/cli/util.js';

import type {ZzzRuntime} from '../runtime/types.ts';
import type {StatusArgs} from '../cli/schemas.ts';
import type {ZzzGlobalArgs} from '../cli/cli_args.ts';
import {get_zzz_daemon_info_path, parse_daemon_info, type ZzzDaemonInfo} from '../cli_config.ts';

/**
 * Show current system state.
 */
export const cmd_status = async (
	runtime: ZzzRuntime,
	args: StatusArgs,
	_flags: ZzzGlobalArgs,
): Promise<void> => {
	const daemon_path = get_zzz_daemon_info_path(runtime);
	if (!daemon_path) {
		log.error('$HOME not set');
		runtime.exit(1);
	}

	// Check daemon
	const stat = await runtime.stat(daemon_path);
	let daemon_info: ZzzDaemonInfo | null = null;
	let daemon_running = false;

	if (stat) {
		try {
			const content = await runtime.read_file(daemon_path);
			daemon_info = parse_daemon_info(content);
			if (daemon_info) {
				const check = await runtime.run_command('kill', ['-0', String(daemon_info.pid)]);
				daemon_running = check.success;
			}
		} catch {
			// ignore
		}
	}

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					daemon: daemon_running ? {running: true, ...daemon_info} : {running: false},
					// TODO: workspaces, repos, watched state
				},
				null,
				'\t',
			),
		);
		return;
	}

	// Daemon status
	if (daemon_running && daemon_info) {
		console.log(
			`${colors.green}Daemon${colors.reset}  running on port ${daemon_info.port} (pid ${daemon_info.pid})`,
		);
	} else {
		console.log(`${colors.dim}Daemon${colors.reset}  not running`);
	}

	// TODO: Show loaded workspaces and watched repos (Phase 3)
	console.log(`\n${colors.dim}Workspace and repo status coming in Phase 3${colors.reset}`);
};
