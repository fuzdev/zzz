/**
 * zzz daemon commands (start, stop, status).
 *
 * The zzz CLI runs in Deno; `daemon start` spawns the compiled Rust
 * `zzz_server` binary as a child process.
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
	check_daemon_health,
	write_daemon_info,
	stop_daemon,
} from '@fuzdev/fuz_app/cli/daemon.js';
import {load_env_file} from '@fuzdev/fuz_app/env/dotenv.js';

import {log} from '../log.js';
import type {ZzzRuntime} from '../runtime/types.ts';
import type {DaemonStartArgs, DaemonStopArgs, DaemonStatusArgs} from '../cli/schemas.ts';
import type {ZzzGlobalArgs} from '../cli/cli_args.ts';
import {VERSION} from '../build_info.ts';
import {ZZZ_DEFAULT_PORT} from '../cli_config.ts';

/**
 * Resolve the compiled `zzz_server` binary: beside the installed CLI first
 * (`~/.zzz/bin/zzz_server`), then the dev-checkout debug build, then bare
 * `zzz_server` on `$PATH`.
 */
const resolve_zzz_server_path = async (runtime: Pick<ZzzRuntime, 'stat'>): Promise<string> => {
	const exec_path = Deno.execPath();
	const exec_dir = exec_path.slice(0, exec_path.lastIndexOf('/'));
	for (const candidate of [`${exec_dir}/zzz_server`, './target/debug/zzz_server']) {
		if (await runtime.stat(candidate)) return candidate;
	}
	return 'zzz_server';
};

/**
 * Start the daemon in the foreground.
 *
 * Spawns the compiled Rust `zzz_server`, waits for it to report healthy,
 * records `daemon.json` for CLI discovery, then blocks until the server exits
 * (Ctrl+C / SIGTERM). The `--port` flag overrides the env / daemon default.
 * (`zzz_server` binds `127.0.0.1` only, so `--host` does not affect binding.)
 */
export const daemon_start = async (
	runtime: ZzzRuntime,
	args: DaemonStartArgs,
	_flags: ZzzGlobalArgs,
): Promise<void> => {
	// Port — CLI flag > env (PORT) > daemon default (4460).
	const env_port = runtime.env_get('PORT');
	const port = args.port ?? (env_port ? Number(env_port) : ZZZ_DEFAULT_PORT);

	// Build the child env: process env + non-overriding dotenv + daemon defaults.
	// zzz_server reads DATABASE_URL / SECRET_FUZ_COOKIE_KEYS / etc. straight from
	// its env (no dotenv loader of its own), so the CLI loads the env file here.
	// `.env` in production, `.env.development` otherwise — keyed off NODE_ENV
	// (the bundler-only `DEV` flag is unset under `deno run` / `deno compile`).
	const env_file = runtime.env_get('NODE_ENV') === 'production' ? '.env' : '.env.development';
	const child_env: Record<string, string> = runtime.env_all();
	const dotenv = await load_env_file(runtime, env_file);
	if (dotenv) {
		for (const [key, value] of Object.entries(dotenv)) {
			if (child_env[key] === undefined) child_env[key] = value;
		}
	}
	if (child_env.PUBLIC_ZZZ_DIR === undefined) {
		child_env.PUBLIC_ZZZ_DIR = `${child_env.HOME ?? '.'}/.zzz`;
	}

	// Warn (don't block) on stale daemon.json from a prior crash.
	const stale = await read_daemon_info(runtime, 'zzz');
	if (stale && !(await is_daemon_running(runtime, stale.pid))) {
		log.warn(`stale daemon.json (pid ${stale.pid} not running), replacing`);
	}

	const bin = await resolve_zzz_server_path(runtime);

	// Spawn the Rust backend. Raw `Deno.Command` (not the runtime command
	// abstraction) is required: we need the child PID for `daemon.json` and a
	// non-blocking handle to health-poll, which `run_command` /
	// `run_command_inherit` don't expose. The CLI is Deno-only by design.
	const child = new Deno.Command(bin, {
		args: ['--port', String(port)],
		env: child_env,
		stdout: 'inherit',
		stderr: 'inherit',
	}).spawn();

	// Wait for the backend to report healthy before recording daemon.json.
	const health_timeout_ms = 30_000;
	const deadline = Date.now() + health_timeout_ms;
	let healthy = false;
	while (Date.now() < deadline) {
		if (await check_daemon_health(runtime, port)) {
			healthy = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	if (!healthy) {
		log.error(`zzz_server did not become healthy within ${health_timeout_ms}ms`);
		try {
			child.kill('SIGTERM');
		} catch {
			// already exited
		}
		await child.status;
		return;
	}

	await write_daemon_info(runtime, 'zzz', {
		version: 1,
		pid: child.pid,
		port,
		started: new Date().toISOString(),
		app_version: VERSION,
	});
	log.success(`Daemon running on http://localhost:${port}`);

	// Foreground lifecycle: forward termination to the child and clean up
	// daemon.json on signal or natural exit.
	let cleaned_up = false;
	const cleanup = async (): Promise<void> => {
		if (cleaned_up) return;
		cleaned_up = true;
		const daemon_path = get_daemon_info_path(runtime, 'zzz');
		if (daemon_path) {
			try {
				await runtime.remove(daemon_path);
			} catch {
				// already removed
			}
		}
	};
	const on_signal = (): void => {
		try {
			child.kill('SIGTERM');
		} catch {
			// already exited
		}
	};
	Deno.addSignalListener('SIGINT', on_signal);
	Deno.addSignalListener('SIGTERM', on_signal);

	await child.status;
	await cleanup();
};

/**
 * Stop the running daemon.
 */
export const daemon_stop = async (
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
export const daemon_status = async (
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

	// Check if process is actually running, then probe health
	const pid_alive = await is_daemon_running(runtime, info.pid);
	const healthy = pid_alive ? await check_daemon_health(runtime, info.port) : false;

	if (args.json) {
		console.log(JSON.stringify({running: pid_alive, healthy, ...info}));
	} else if (pid_alive && healthy) {
		console.log(`${colors.green}Daemon running${colors.reset}`);
		console.log(`  PID:     ${info.pid}`);
		console.log(`  Port:    ${info.port}`);
		console.log(`  Version: ${info.app_version}`);
		console.log(`  Started: ${info.started}`);
		console.log(`  URL:     ${colors.cyan}http://localhost:${info.port}${colors.reset}`);
	} else if (pid_alive) {
		console.log(`${colors.yellow}Daemon process alive but not responding${colors.reset}`);
		console.log(`  PID:     ${info.pid}`);
		console.log(`  Port:    ${info.port} (not listening)`);
		console.log(`  Version: ${info.app_version}`);
		console.log(`  Started: ${info.started}`);
		log.warn(
			'The process exists but is not serving on the expected port. It may be a different process.',
		);
	} else {
		log.warn('Stale daemon.json found (process not running)');
		const daemon_path = get_daemon_info_path(runtime, 'zzz');
		if (daemon_path) await runtime.remove(daemon_path);
		log.info('Cleaned up stale daemon.json');
	}
};
