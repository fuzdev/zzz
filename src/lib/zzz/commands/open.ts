/**
 * zzz open command (default command).
 *
 * Opens the zzz browser UI, auto-starting the daemon if needed.
 * Handles: `zzz`, `zzz <file>`, `zzz <dir>`.
 *
 * @module
 */

import {colors, log} from '@fuzdev/fuz_app/cli/util.js';

import type {ZzzRuntime} from '../runtime/types.ts';
import type {OpenArgs} from '../cli/schemas.ts';
import type {ZzzGlobalArgs} from '../cli/cli_args.ts';
import {
	get_zzz_dir,
	get_zzz_daemon_info_path,
	parse_daemon_info,
	type ZzzDaemonInfo,
} from '../cli_config.ts';

/**
 * Check if the daemon is running.
 *
 * @returns Daemon info if running, null otherwise.
 */
const check_daemon = async (
	runtime: Pick<ZzzRuntime, 'env_get' | 'stat' | 'read_file' | 'run_command' | 'remove'>,
): Promise<ZzzDaemonInfo | null> => {
	const daemon_path = get_zzz_daemon_info_path(runtime);
	if (!daemon_path) return null;

	const stat = await runtime.stat(daemon_path);
	if (!stat) return null;

	try {
		const content = await runtime.read_file(daemon_path);
		const info = parse_daemon_info(content);
		if (!info) {
			await runtime.remove(daemon_path);
			return null;
		}

		// Check if process is actually running
		const check = await runtime.run_command('kill', ['-0', String(info.pid)]);
		if (check.success) {
			return info;
		}

		// Stale — clean up
		await runtime.remove(daemon_path);
		return null;
	} catch {
		return null;
	}
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
export const cmd_open = async (
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

	// Build URL
	const target = resolve_path(runtime, args._[0]);
	let url = `http://localhost:${daemon_info.port}`;
	if (target) {
		url += `?open=${encodeURIComponent(target)}`;
	}

	log.info(`Opening ${colors.cyan}${url}${colors.reset}`);
	await open_browser(runtime, url);
};
