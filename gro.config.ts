import {spawn} from 'node:child_process';
import {copyFile, mkdir, chmod} from 'node:fs/promises';
import type {CreateGroConfig, Plugin} from '@fuzdev/gro';
import {gro_plugin_deno_compile} from '@fuzdev/gro/gro_plugin_deno_compile.js';

const OUTPUT_DIR = './dist_cli';

/** Run a command inheriting stdio; reject on non-zero exit. */
const run = (cmd: string, args: Array<string>): Promise<void> =>
	new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {stdio: 'inherit'});
		child.on('error', reject);
		child.on('exit', (code) =>
			code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
		);
	});

/** Whether a command is runnable (`<cmd> --version` exits 0). */
const command_exists = (cmd: string): Promise<boolean> =>
	new Promise((resolve) => {
		const child = spawn(cmd, ['--version'], {stdio: 'ignore'});
		child.on('error', () => resolve(false));
		child.on('exit', (code) => resolve(code === 0));
	});

/**
 * Build the Rust `zzz_server` and place it beside the compiled CLI so
 * `zzz daemon start` can spawn it (production binary discovery — the CLI
 * looks for `zzz_server` next to its own executable first).
 *
 * Skips (with a warning) when `cargo` is unavailable or the build fails —
 * the toolchain-free CI `build` job runs `gro check --build`, which would
 * otherwise fail here. A real release build (cargo + the sibling Rust
 * workspace present) produces the binary; the warning flags when it didn't.
 */
const gro_plugin_zzz_server: Plugin = {
	name: 'gro_plugin_zzz_server',
	adapt: async ({log}) => {
		if (!(await command_exists('cargo'))) {
			log.warn(
				'[gro_plugin_zzz_server] cargo not found — skipping zzz_server build; ' +
					'`zzz daemon start` needs a prebuilt zzz_server beside the CLI',
			);
			return;
		}
		log.info('[gro_plugin_zzz_server] building zzz_server (release)');
		try {
			await run('cargo', ['build', '-p', 'zzz_server', '--release']);
		} catch (err) {
			log.warn(
				`[gro_plugin_zzz_server] zzz_server build failed, skipping copy (${err}); ` +
					'`zzz daemon start` needs a prebuilt zzz_server beside the CLI',
			);
			return;
		}
		await mkdir(OUTPUT_DIR, {recursive: true});
		const dest = `${OUTPUT_DIR}/zzz_server`;
		await copyFile('target/release/zzz_server', dest);
		await chmod(dest, 0o755);
		log.info(`[gro_plugin_zzz_server] copied zzz_server → ${dest}`);
	},
};

// eslint-disable-next-line @typescript-eslint/require-await
const config: CreateGroConfig = async (base_config) => {
	const base_plugins = base_config.plugins;
	base_config.plugins = async (ctx) => {
		// Drop gro's default dev server — zzz's backend is the Rust `zzz_server`
		// binary (run via `deno task dev` in dev, `zzz daemon start` in prod).
		const plugins = (await base_plugins(ctx)).filter((p) => p.name !== 'gro_plugin_server');
		return [
			...plugins,
			gro_plugin_deno_compile({
				entry: 'src/lib/zzz/main.ts',
				output_name: 'zzz',
				flags: ['--no-check', '--sloppy-imports'],
			}),
			gro_plugin_zzz_server,
		];
	};

	return base_config;
};

export default config;
