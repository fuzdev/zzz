/**
 * zzz CLI argument parsing and help.
 *
 * Thin wrapper around argv_parse + extract_global_flags.
 *
 * @module
 */

import {argv_parse, type ParsedArgs} from '@fuzdev/fuz_util/args.js';

import {NAME, VERSION} from './build_info.ts';
import {extract_global_flags, type ZzzGlobalArgs} from './cli/cli_args.ts';
import {get_help_text} from './cli/cli_help.ts';

/**
 * Result of parsing raw CLI arguments.
 */
export interface ZzzParsedArgs {
	command: string | undefined;
	subcmd: string | undefined;
	flags: ZzzGlobalArgs;
	remaining: ParsedArgs;
}

/**
 * Parse zzz CLI arguments.
 *
 * Phase 1: argv_parse for raw tokenization.
 * Phase 2: extract_global_flags for --help/-h, --version/-v.
 * Phase 3: Extract command and subcommand from positionals.
 *
 * @param args - raw CLI arguments from Deno.args
 * @returns parsed argument structure
 */
export const parse_zzz_args = (args: Array<string>): ZzzParsedArgs => {
	const raw = argv_parse(args);
	const {flags, remaining} = extract_global_flags(raw);

	const command = remaining._[0];
	const subcmd = remaining._[1];

	return {command, subcmd, flags, remaining};
};

/**
 * Display help message.
 */
export const show_help = (command?: string, subcommand?: string): void => {
	console.log(get_help_text(command, subcommand));
};

/**
 * Display version.
 */
export const show_version = (): void => {
	console.log(`${NAME} v${VERSION}`);
};
