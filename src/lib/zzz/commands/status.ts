/**
 * zzz status command.
 *
 * Show current system state (daemon status, loaded workspaces, watched repos).
 *
 * @module
 */

import {colors} from '@fuzdev/fuz_app/cli/util.js';
import {
	read_daemon_info,
	is_daemon_running,
	check_daemon_health,
	type DaemonInfo,
} from '@fuzdev/fuz_app/cli/daemon.js';

import type {ZzzRuntime} from '../runtime/types.ts';
import type {StatusArgs} from '../cli/schemas.ts';
import type {ZzzGlobalArgs} from '../cli/cli_args.ts';

/**
 * Show current system state.
 */
export const status = async (
	runtime: ZzzRuntime,
	args: StatusArgs,
	_flags: ZzzGlobalArgs,
): Promise<void> => {
	// Check daemon
	let daemon_info: DaemonInfo | null = null;
	let pid_alive = false;
	let healthy = false;

	const info = await read_daemon_info(runtime, 'zzz');
	if (info) {
		daemon_info = info;
		pid_alive = await is_daemon_running(runtime, info.pid);
		if (pid_alive) {
			healthy = await check_daemon_health(info.port);
		}
	}

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					daemon:
						pid_alive && daemon_info
							? {running: true, healthy, ...daemon_info}
							: {running: false},
					// TODO: workspaces, repos, watched state
				},
				null,
				'\t',
			),
		);
		return;
	}

	// Daemon status
	if (pid_alive && daemon_info) {
		if (healthy) {
			console.log(
				`${colors.green}Daemon${colors.reset}  running on port ${daemon_info.port} (pid ${daemon_info.pid})`,
			);
		} else {
			console.log(
				`${colors.yellow}Daemon${colors.reset}  process alive (pid ${daemon_info.pid}) but not responding on port ${daemon_info.port}`,
			);
		}
	} else {
		console.log(`${colors.dim}Daemon${colors.reset}  not running`);
	}

	// TODO: Show loaded workspaces and watched repos (Phase 3)
	console.log(`\n${colors.dim}Workspace and repo status coming in Phase 3${colors.reset}`);
};
