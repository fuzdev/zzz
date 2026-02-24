/**
 * zzz status command.
 *
 * Show current system state (daemon status, loaded workspaces, watched repos).
 *
 * @module
 */

import {colors} from '@fuzdev/fuz_app/cli/util.js';
import {read_daemon_info, is_daemon_running, type DaemonInfo} from '@fuzdev/fuz_app/cli/daemon.js';

import type {ZzzRuntime} from '../runtime/types.ts';
import type {StatusArgs} from '../cli/schemas.ts';
import type {ZzzGlobalArgs} from '../cli/cli_args.ts';

/**
 * Show current system state.
 */
export const cmd_status = async (
	runtime: ZzzRuntime,
	args: StatusArgs,
	_flags: ZzzGlobalArgs,
): Promise<void> => {
	// Check daemon
	let daemon_info: DaemonInfo | null = null;
	let daemon_running = false;

	const info = await read_daemon_info(runtime, 'zzz');
	if (info) {
		daemon_info = info;
		daemon_running = await is_daemon_running(runtime, info.pid);
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
