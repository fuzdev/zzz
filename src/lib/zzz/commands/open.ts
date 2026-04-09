/**
 * zzz open command (default command).
 *
 * Opens the zzz browser UI, auto-starting the daemon if needed.
 * Handles: `zzz`, `zzz <file>`, `zzz <dir>`.
 *
 * @module
 */

import {colors} from '@fuzdev/fuz_app/cli/util.js';
import {
	get_daemon_info_path,
	read_daemon_info,
	is_daemon_running,
	check_daemon_health,
	type DaemonInfo,
} from '@fuzdev/fuz_app/cli/daemon.js';

import {log} from '../log.js';
import type {ZzzRuntime} from '../runtime/types.ts';
import type {OpenArgs} from '../cli/schemas.ts';
import type {ZzzGlobalArgs} from '../cli/cli_args.ts';
import {get_zzz_dir} from '../cli_config.ts';

/**
 * Check if the daemon is running.
 *
 * @returns daemon info if running, null otherwise
 */
const check_daemon = async (
	runtime: Pick<
		ZzzRuntime,
		'env_get' | 'stat' | 'read_text_file' | 'run_command' | 'remove' | 'warn'
	>,
): Promise<DaemonInfo | null> => {
	const info = await read_daemon_info(runtime, 'zzz');
	if (!info) return null;

	// Check if process is actually running and responding
	const pid_alive = await is_daemon_running(runtime, info.pid);
	if (!pid_alive) {
		// Process is dead — fall through to stale cleanup
	} else if (await check_daemon_health(info.port)) {
		return info;
	} else {
		// PID alive but not responding — treat as not running
		log.warn(`Daemon process alive (pid ${info.pid}) but not responding on port ${info.port}`);
	}

	// Stale — clean up
	const daemon_path = get_daemon_info_path(runtime, 'zzz');
	if (daemon_path) {
		try {
			await runtime.remove(daemon_path);
		} catch {
			// already removed
		}
	}
	return null;
};

/**
 * Open the browser to a URL.
 */
const open_browser = async (
	runtime: Pick<ZzzRuntime, 'run_command'>,
	url: string,
): Promise<void> => {
	// Try xdg-open (Linux), then open (macOS), then start (Windows)
	const openers = ['xdg-open', 'open', 'start'];
	for (const opener of openers) {
		const result = await runtime.run_command(opener, [url]); // eslint-disable-line no-await-in-loop
		if (result.success) return;
	}
	// If all fail, just print the URL
	log.info(`Open in browser: ${colors.cyan}${url}${colors.reset}`);
};

/**
 * Resolve the target path to an absolute path.
 */
const resolve_path = (
	runtime: Pick<ZzzRuntime, 'cwd'>,
	path: string | undefined,
): string | undefined => {
	if (!path) return undefined;
	if (path.startsWith('/')) return path;
	if (path.startsWith('~')) {
		// Don't resolve ~ here — the server handles it
		return path;
	}
	return `${runtime.cwd()}/${path}`;
};

/**
 * Open the zzz UI in a browser, auto-starting the daemon if needed.
 */
export const open = async (
	runtime: ZzzRuntime,
	args: OpenArgs,
	_flags: ZzzGlobalArgs,
): Promise<void> => {
	const zzz_dir = get_zzz_dir(runtime);
	if (!zzz_dir) {
		log.error('$HOME not set');
		runtime.exit(1);
	}

	// Check if initialized
	const dir_stat = await runtime.stat(zzz_dir);
	if (!dir_stat) {
		log.error('zzz not initialized');
		console.log(`\nRun ${colors.cyan}zzz init${colors.reset} first.`);
		runtime.exit(1);
	}

	// Check if daemon is running
	const daemon_info = await check_daemon(runtime);

	if (!daemon_info) {
		// TODO: Auto-start daemon in background using spawn_detached
		// For now, tell the user to start it manually
		log.error('Daemon not running');
		console.log(`\nRun ${colors.cyan}zzz daemon start${colors.reset} first.`);
		console.log(`(Auto-start coming in Phase 2)`);
		runtime.exit(1);
	}

	// Resolve the target path
	const target = resolve_path(runtime, args._[0]);

	// If a directory was specified, tell the daemon to open it as a workspace
	if (target) {
		const workspace_path = target.endsWith('/') ? target : target + '/';
		try {
			const response = await fetch(`http://localhost:${daemon_info.port}/api/rpc`, {
				method: 'POST',
				headers: {'Content-Type': 'application/json'},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'workspace_open',
					params: {path: workspace_path},
				}),
			});
			if (!response.ok) {
				log.warn(`workspace_open request failed: ${response.status}`);
			} else {
				const result = await response.json();
				if (result.error) {
					log.warn(`workspace_open error: ${result.error.message}`);
				} else {
					log.info(`Workspace opened: ${workspace_path}`);
				}
			}
		} catch (error) {
			log.warn(
				`Failed to contact daemon: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		}
	}

	// Build URL
	let url = `http://localhost:${daemon_info.port}`;
	if (target) {
		url += `/workspaces?workspace=${encodeURIComponent(target)}`;
	}

	log.info(`Opening ${colors.cyan}${url}${colors.reset}`);
	await open_browser(runtime, url);
};
