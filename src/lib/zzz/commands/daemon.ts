/**
 * zzz daemon commands (start, stop, status).
 *
 * The zzz CLI runs in Deno, so daemon start uses the Deno server entry point.
 *
 * Routing (`zzz daemon start|stop|status`) is handled by
 * create_subcommand_router in main.ts.
 *
 * @module
 */

import {colors} from '@fuzdev/fuz_app/cli/util.js';
import {
	get_daemon_info_path,
	read_daemon_info,
	is_daemon_running,
	stop_daemon,
} from '@fuzdev/fuz_app/cli/daemon.js';

import {log} from '../log.js';
import type {ZzzRuntime} from '../runtime/types.ts';
import type {DaemonStartArgs, DaemonStopArgs, DaemonStatusArgs} from '../cli/schemas.ts';
import type {ZzzGlobalArgs} from '../cli/cli_args.ts';
import {start_server_deno} from '../../server/server_deno.ts';

/**
 * Start the daemon in foreground mode.
 *
 * CLI flags --port and --host override config values.
 */
export const cmd_daemon_start = async (
	runtime: ZzzRuntime,
	args: DaemonStartArgs,
	_flags: ZzzGlobalArgs,
): Promise<void> => {
	// Override env with CLI flags (these take precedence)
	if (args.port) runtime.env_set('PORT', String(args.port));
	if (args.host) runtime.env_set('HOST', args.host);

	// Start Deno server (zzz CLI always runs in Deno)
	await start_server_deno();
};

/**
 * Stop the running daemon.
 */
export const cmd_daemon_stop = async (
	runtime: ZzzRuntime,
	_args: DaemonStopArgs,
	_flags: ZzzGlobalArgs,
): Promise<void> => {
	const result = await stop_daemon(runtime, 'zzz');
	if (result.stopped) {
		log.success(result.message);
	} else if (result.pid) {
		log.warn(result.message);
	} else {
		log.info(result.message);
	}
};

/**
 * Show daemon status.
 */
export const cmd_daemon_status = async (
	runtime: ZzzRuntime,
	args: DaemonStatusArgs,
	_flags: ZzzGlobalArgs,
): Promise<void> => {
	const info = await read_daemon_info(runtime, 'zzz');
	if (!info) {
		if (args.json) {
			console.log(JSON.stringify({running: false}));
		} else {
			log.info('No daemon running');
		}
		return;
	}

	// Check if process is actually running
	const running = await is_daemon_running(runtime, info.pid);

	if (args.json) {
		console.log(JSON.stringify({running, ...info}));
	} else if (running) {
		console.log(`${colors.green}Daemon running${colors.reset}`);
		console.log(`  PID:     ${info.pid}`);
		console.log(`  Port:    ${info.port}`);
		console.log(`  Version: ${info.app_version}`);
		console.log(`  Started: ${info.started}`);
		console.log(`  URL:     ${colors.cyan}http://localhost:${info.port}${colors.reset}`);
	} else {
		log.warn('Stale daemon.json found (process not running)');
		const daemon_path = get_daemon_info_path(runtime, 'zzz');
		if (daemon_path) await runtime.remove(daemon_path);
		log.info('Cleaned up stale daemon.json');
	}
};
