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

import {colors, log} from '@fuzdev/fuz_app/cli/util.js';

import type {ZzzRuntime} from '../runtime/types.ts';
import type {DaemonStartArgs, DaemonStopArgs, DaemonStatusArgs} from '../cli/schemas.ts';
import type {ZzzGlobalArgs} from '../cli/cli_args.ts';
import {get_zzz_daemon_info_path, parse_daemon_info} from '../cli_config.ts';
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
	const daemon_path = get_zzz_daemon_info_path(runtime);
	if (!daemon_path) {
		log.error('$HOME not set');
		runtime.exit(1);
	}

	// Read daemon info
	const stat = await runtime.stat(daemon_path);
	if (!stat) {
		log.info('No daemon running (no daemon.json found)');
		return;
	}

	const content = await runtime.read_file(daemon_path);
	const info = parse_daemon_info(content);
	if (!info) {
		log.warn('Corrupt daemon.json, removing');
		try {
			await runtime.remove(daemon_path);
		} catch {
			// already removed
		}
		return;
	}

	// Send SIGTERM to the daemon process
	const result = await runtime.run_command('kill', [String(info.pid)]);
	if (result.success) {
		log.success(`Stopped daemon (pid ${info.pid})`);
	} else {
		log.warn(`Process ${info.pid} not running, cleaning up stale daemon.json`);
	}

	// Clean up daemon.json (may already be removed by the daemon's own shutdown handler)
	try {
		await runtime.remove(daemon_path);
	} catch {
		// already removed
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
	const daemon_path = get_zzz_daemon_info_path(runtime);
	if (!daemon_path) {
		log.error('$HOME not set');
		runtime.exit(1);
	}

	const stat = await runtime.stat(daemon_path);
	if (!stat) {
		if (args.json) {
			console.log(JSON.stringify({running: false}));
		} else {
			log.info('No daemon running');
		}
		return;
	}

	const content = await runtime.read_file(daemon_path);
	const info = parse_daemon_info(content);
	if (!info) {
		log.warn('Corrupt daemon.json, removing');
		await runtime.remove(daemon_path);
		return;
	}

	// Check if process is actually running
	const check = await runtime.run_command('kill', ['-0', String(info.pid)]);
	const running = check.success;

	if (args.json) {
		console.log(JSON.stringify({running, ...info}));
	} else if (running) {
		console.log(`${colors.green}Daemon running${colors.reset}`);
		console.log(`  PID:     ${info.pid}`);
		console.log(`  Port:    ${info.port}`);
		console.log(`  Version: ${info.zzz_version}`);
		console.log(`  Started: ${info.started}`);
		console.log(`  URL:     ${colors.cyan}http://localhost:${info.port}${colors.reset}`);
	} else {
		log.warn('Stale daemon.json found (process not running)');
		await runtime.remove(daemon_path);
		log.info('Cleaned up stale daemon.json');
	}
};
