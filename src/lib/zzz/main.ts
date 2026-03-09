/**
 * zzz CLI entry point.
 *
 * @module
 */

import {colors} from '@fuzdev/fuz_app/cli/util.js';

import {log} from './log.js';
import type {ZzzRuntime} from './runtime/types.ts';
import {create_deno_runtime} from '@fuzdev/fuz_app/runtime/deno.js';
import {parse_zzz_args, show_help, show_version} from './cli.ts';
import {dispatch, create_subcommand_router, type SubcommandRoute} from './cli/cli_args.ts';
import {
	InitArgs,
	DaemonStartArgs,
	DaemonStopArgs,
	DaemonStatusArgs,
	StatusArgs,
	OpenArgs,
} from './cli/schemas.ts';
import {init} from './commands/init.ts';
import {daemon_start, daemon_stop, daemon_status} from './commands/daemon.ts';
import {open} from './commands/open.ts';
import {status} from './commands/status.ts';

//
// Subcommand routers
//

/**
 * Daemon subcommand router.
 */
const route_daemon = create_subcommand_router<ZzzRuntime>(
	{
		start: {
			schema: DaemonStartArgs,
			handler: async (runtime, args, flags) => {
				await daemon_start(runtime, args, flags);
			},
		},
		stop: {
			schema: DaemonStopArgs,
			handler: async (runtime, args, flags) => {
				await daemon_stop(runtime, args, flags);
			},
		},
		status: {
			schema: DaemonStatusArgs,
			handler: async (runtime, args, flags) => {
				await daemon_status(runtime, args, flags);
			},
		},
	} satisfies Record<string, SubcommandRoute<ZzzRuntime>>,
	undefined,
	'Missing subcommand. Usage: zzz daemon start|stop|status',
);

/**
 * Main CLI dispatcher.
 */
const main = async (runtime: ZzzRuntime): Promise<void> => {
	const {command, subcmd, flags, remaining} = parse_zzz_args([...runtime.args]);

	// Handle --help flag
	if (flags.help) {
		show_help(command, subcmd);
		runtime.exit(0);
	}

	// Handle --version flag
	if (flags.version) {
		show_version();
		runtime.exit(0);
	}

	// No command provided — default to open (like `code .`)
	if (!command) {
		await dispatch(remaining, OpenArgs, async (args) => {
			await open(runtime, args, flags);
		});
		return;
	}

	// Check if the first positional looks like a path (not a known command)
	const known_commands = new Set(['init', 'daemon', 'status', 'version', 'open']);
	if (!known_commands.has(command)) {
		// Treat as a path argument to the open command
		// Don't shift — the path is the first positional
		await dispatch(remaining, OpenArgs, async (args) => {
			await open(runtime, args, flags);
		});
		return;
	}

	// Consume command from positionals before dispatching
	remaining._.shift();

	try {
		switch (command) {
			case 'version':
				show_version();
				break;

			case 'open':
				await dispatch(remaining, OpenArgs, async (args) => {
					await open(runtime, args, flags);
				});
				break;

			case 'init':
				await dispatch(remaining, InitArgs, async (args) => {
					await init(runtime, args, flags);
				});
				break;

			case 'daemon':
				await route_daemon(remaining, runtime, flags);
				break;

			case 'status':
				await dispatch(remaining, StatusArgs, async (args) => {
					await status(runtime, args, flags);
				});
				break;

			default:
				log.error(`Unknown command: ${colors.bold}${command}${colors.reset}`);
				console.log('\nRun zzz --help for usage information.');
				runtime.exit(1);
		}
	} catch (err) {
		log.error((err as Error).message);
		console.log('\nRun zzz --help for usage information.');
		runtime.exit(1);
	}
};

// Run
await main(create_deno_runtime(Deno.args));
