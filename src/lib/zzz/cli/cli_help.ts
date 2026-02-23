/**
 * CLI help generation and command metadata.
 *
 * @module
 */

import {z} from 'zod';

import {
	DaemonStartArgs,
	DaemonStopArgs,
	DaemonStatusArgs,
	InitArgs,
	StatusArgs,
	OpenArgs,
} from './schemas.ts';
import {ZzzGlobalArgs} from './cli_args.ts';
import {zod_to_schema_properties, zod_format_value, type ZodSchemaProperty} from '../zod.ts';
import {NAME, VERSION} from '../build_info.ts';
import {colors} from './util.ts';

//
// Types
//

/**
 * Command category for help organization.
 */
export type ZzzCommandCategory = 'main' | 'management' | 'info';

/**
 * Command metadata for help generation.
 */
export interface CommandMeta {
	schema?: z.ZodType;
	summary: string;
	usage: string;
	category: ZzzCommandCategory;
}

/**
 * Category configuration for help display.
 */
export interface HelpCategory {
	key: ZzzCommandCategory;
	title: string;
}

//
// Configuration
//

/**
 * Category display order for main help.
 */
export const ZZZ_HELP_CATEGORIES: Array<HelpCategory> = [
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
export const ZZZ_COMMANDS: Record<string, CommandMeta> = {
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
// Formatting Helpers
//

/**
 * Get maximum length from array.
 */
const to_max_length = <T>(items: Array<T>, to_string: (item: T) => string): number =>
	items.reduce((max, item) => Math.max(to_string(item).length, max), 0);

/**
 * Format argument name with short aliases for display.
 */
const format_arg_name = (prop: ZodSchemaProperty): string => {
	if (prop.name === '_') {
		return '[...args]';
	}
	let name = `--${prop.name}`;
	const short_aliases = prop.aliases.filter((a) => a.length === 1);
	if (short_aliases.length > 0) {
		const alias_str = short_aliases.map((a) => `-${a}`).join(', ');
		name = `${alias_str}, ${name}`;
	}
	return name;
};

//
// Help Generation
//

/**
 * Generate help text for a command from its metadata.
 */
export const generate_command_help = (command: string, meta: CommandMeta): string => {
	const lines: Array<string> = [];

	lines.push(`${colors.cyan}${NAME} ${command}${colors.reset}: ${meta.summary}`);
	lines.push('');
	lines.push(`${colors.yellow}Usage${colors.reset}: ${meta.usage}`);
	lines.push('');

	if (meta.schema) {
		const properties = zod_to_schema_properties(meta.schema);
		const flag_props = properties.filter((p) => p.name !== '_');
		const positional_prop = properties.find((p) => p.name === '_');

		if (positional_prop?.description) {
			lines.push(`Positional: ${positional_prop.description}`);
			lines.push('');
		}

		if (flag_props.length > 0) {
			lines.push(`${colors.yellow}Options${colors.reset}:`);

			const longest_name = to_max_length(flag_props, format_arg_name);
			const longest_type = to_max_length(flag_props, (p) => p.type);

			for (const prop of flag_props) {
				const name = format_arg_name(prop).padEnd(longest_name);
				const type = prop.type.padEnd(longest_type);
				const def = zod_format_value(prop.default);
				const desc = prop.description || '';
				const default_str = def ? ` (default: ${def})` : '';
				lines.push(`  ${name}  ${type}  ${desc}${default_str}`);
			}
		}
	}

	// Global options
	lines.push('');
	lines.push(`${colors.yellow}Global Options${colors.reset}:`);
	for (const opt_line of generate_global_options()) {
		lines.push(opt_line);
	}

	return lines.join('\n');
};

/**
 * Generate global options section from ZzzGlobalArgs schema.
 */
const generate_global_options = (): Array<string> => {
	const properties = zod_to_schema_properties(ZzzGlobalArgs);
	const max_width = to_max_length(properties, (p) => `  ${format_arg_name(p)}`);

	return properties.map((prop) => {
		const name = format_arg_name(prop);
		const desc = prop.description || '';
		return `  ${name}`.padEnd(max_width + 2) + desc;
	});
};

/**
 * Generate main help text.
 */
export const generate_main_help = (): string => {
	const lines: Array<string> = [];

	lines.push(
		`${colors.cyan}${NAME}${colors.reset} v${VERSION} - local-first forge for power users and devs`,
	);
	lines.push('');

	// Categories with commands
	for (const {key, title} of ZZZ_HELP_CATEGORIES) {
		const cat_commands = Object.entries(ZZZ_COMMANDS).filter(([_, meta]) => meta.category === key);
		if (cat_commands.length === 0) continue;

		lines.push(`${colors.yellow}${title}${colors.reset}:`);

		cat_commands.sort(([a], [b]) => a.localeCompare(b));

		const max_usage_width = to_max_length(cat_commands, ([_, meta]) => `  ${meta.usage}`);

		for (const [_, meta] of cat_commands) {
			const padded = `  ${meta.usage}`.padEnd(Math.max(max_usage_width + 2, 40));
			lines.push(`${padded}${meta.summary}`);
		}
		lines.push('');
	}

	// Global options
	lines.push(`${colors.yellow}OPTIONS${colors.reset}:`);
	for (const opt_line of generate_global_options()) {
		lines.push(opt_line);
	}
	lines.push('');

	// Examples
	if (ZZZ_HELP_EXAMPLES.length > 0) {
		lines.push(`${colors.yellow}EXAMPLES${colors.reset}:`);
		for (const example of ZZZ_HELP_EXAMPLES) {
			lines.push(`  ${example}`);
		}
	}

	return lines.join('\n');
};

/**
 * Get help text for a command or main help.
 */
export const get_help_text = (command?: string, subcommand?: string): string => {
	const cmd_key = subcommand ? `${command} ${subcommand}` : command;
	if (cmd_key && ZZZ_COMMANDS[cmd_key]) {
		return generate_command_help(cmd_key, ZZZ_COMMANDS[cmd_key]);
	}

	return generate_main_help();
};
