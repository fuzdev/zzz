/**
 * CLI help generation and command metadata.
 *
 * @module
 */

import {create_help, type CommandMeta, type HelpCategory} from '@fuzdev/fuz_app/cli/help.js';

import {
	DaemonStartArgs,
	DaemonStopArgs,
	DaemonStatusArgs,
	InitArgs,
	StatusArgs,
	OpenArgs,
} from './schemas.ts';
import {ZzzGlobalArgs} from './cli_args.ts';
import {NAME, VERSION} from '../build_info.ts';

//
// Types
//

/**
 * Command category for help organization.
 */
export type ZzzCommandCategory = 'main' | 'management' | 'info';

//
// Configuration
//

/**
 * Category display order for main help.
 */
export const ZZZ_HELP_CATEGORIES: Array<HelpCategory<ZzzCommandCategory>> = [
	{key: 'main', title: 'MAIN'},
	{key: 'management', title: 'MANAGEMENT'},
	{key: 'info', title: 'INFO'},
];

/**
 * Example commands for main help.
 */
export const ZZZ_HELP_EXAMPLES: Array<string> = [
	`${NAME}                          Start daemon and open browser`,
	`${NAME} ~/dev/                   Open workspace at ~/dev/`,
	`${NAME} foo.ts                   Open file in browser`,
	`${NAME} init                     Initialize ~/.zzz/`,
	`${NAME} daemon start             Start daemon (foreground)`,
	`${NAME} daemon status            Show daemon info`,
	`${NAME} status                   Show what's loaded`,
];

/**
 * Command registry for help generation.
 */
export const ZZZ_COMMANDS: Record<string, CommandMeta<ZzzCommandCategory>> = {
	open: {
		schema: OpenArgs,
		summary: 'Open file or directory in browser (default command)',
		usage: `${NAME} [path]`,
		category: 'main',
	},
	init: {
		schema: InitArgs,
		summary: 'Initialize zzz configuration (~/.zzz/)',
		usage: `${NAME} init [options]`,
		category: 'management',
	},
	'daemon start': {
		schema: DaemonStartArgs,
		summary: 'Start the zzz daemon (foreground)',
		usage: `${NAME} daemon start [options]`,
		category: 'management',
	},
	'daemon stop': {
		schema: DaemonStopArgs,
		summary: 'Stop the running daemon',
		usage: `${NAME} daemon stop`,
		category: 'management',
	},
	'daemon status': {
		schema: DaemonStatusArgs,
		summary: 'Show daemon status',
		usage: `${NAME} daemon status [options]`,
		category: 'management',
	},
	status: {
		schema: StatusArgs,
		summary: 'Show current system state',
		usage: `${NAME} status [options]`,
		category: 'info',
	},
	version: {
		summary: 'Show version information',
		usage: `${NAME} version`,
		category: 'info',
	},
};

//
// Help Generation
//

const zzz_help = create_help({
	name: NAME,
	version: VERSION,
	description: 'local-first forge for power users and devs',
	commands: ZZZ_COMMANDS,
	categories: ZZZ_HELP_CATEGORIES,
	examples: ZZZ_HELP_EXAMPLES,
	global_args_schema: ZzzGlobalArgs,
});

export const {generate_main_help, generate_command_help, get_help_text} = zzz_help;
