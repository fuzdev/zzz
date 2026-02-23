/**
 * CLI argument parsing utilities for zzz.
 *
 * Provides shared parsing utilities for CLI commands.
 *
 * @module
 */

import {args_parse, type Args, type ParsedArgs, type ArgValue} from '@fuzdev/fuz_util/args.js';
import {z} from 'zod';

import {zod_to_schema_properties, zod_to_schema_names_with_aliases} from '../zod.ts';

//
// Global Args
//

/**
 * Global CLI flags.
 * Extracted before command-specific parsing.
 */
export const ZzzGlobalArgs = z.strictObject({
	help: z
		.boolean()
		.meta({aliases: ['h'], description: 'show help'})
		.default(false),
	version: z
		.boolean()
		.meta({aliases: ['v'], description: 'show version'})
		.default(false),
});
export type ZzzGlobalArgs = z.infer<typeof ZzzGlobalArgs>;

//
// Parsing Utilities
//

type ParseResult<T> = {success: true; data: T} | {success: false; error: string};

/**
 * Extract global flags from parsed args.
 *
 * @param unparsed - Raw parsed args from argv_parse.
 * @returns Global flags and remaining args.
 */
export const extract_global_flags = (
	unparsed: ParsedArgs,
): {flags: ZzzGlobalArgs; remaining: ParsedArgs} => {
	const global_names = zod_to_schema_names_with_aliases(ZzzGlobalArgs);
	const global_props = zod_to_schema_properties(ZzzGlobalArgs);

	// Extract global flag values, handling aliases
	const flags_input: Record<string, unknown> = {};
	for (const prop of global_props) {
		if (prop.name in unparsed) {
			flags_input[prop.name] = unparsed[prop.name];
		} else {
			for (const alias of prop.aliases) {
				if (alias in unparsed) {
					flags_input[prop.name] = unparsed[alias];
					break;
				}
			}
		}
	}

	// Parse global flags
	const global_parsed = args_parse(flags_input as Args, ZzzGlobalArgs);
	const flags = global_parsed.success ? global_parsed.data : {help: false, version: false};

	// Build remaining args without global flags
	const remaining: ParsedArgs = {_: [...unparsed._]};
	for (const [key, value] of Object.entries(unparsed)) {
		if (key === '_') continue;
		if (global_names.has(key)) continue;
		remaining[key] = value;
	}

	return {flags, remaining};
};

/**
 * Parse command-specific args with a schema.
 *
 * @param remaining - Remaining args after global flag extraction.
 * @param schema - Zod schema for the command.
 * @returns Parse result with typed data or error message.
 */
export const parse_command_args = <T extends Record<string, unknown>>(
	remaining: ParsedArgs,
	schema: z.ZodType<T>,
): ParseResult<T> => {
	const parsed = args_parse(remaining as Args, schema as z.ZodType<T & Record<string, ArgValue>>);
	if (!parsed.success) {
		return {success: false, error: z.prettifyError(parsed.error)};
	}
	return {success: true, data: parsed.data as T};
};

/**
 * Parse args and dispatch to handler, with error handling.
 *
 * @param remaining - Remaining args after global flag extraction.
 * @param schema - Zod schema for the command.
 * @param handler - Command handler to call with parsed args.
 */
export const dispatch = async <T extends Record<string, unknown>>(
	remaining: ParsedArgs,
	schema: z.ZodType<T>,
	handler: (args: T) => Promise<void>,
): Promise<void> => {
	const parsed = parse_command_args(remaining, schema);
	if (!parsed.success) {
		throw new Error(parsed.error);
	}
	return handler(parsed.data);
};

//
// Subcommand Routing
//

/**
 * Route definition for subcommand routing.
 */
export interface SubcommandRoute<TContext> {
	schema: z.ZodType<any>;
	handler: (ctx: TContext, args: any, flags: ZzzGlobalArgs) => Promise<void>;
}

/**
 * Create a subcommand router from route definitions.
 *
 * @param routes - Map of subcommand names to route definitions.
 * @param default_handler - Optional handler for when no subcommand is provided.
 * @param error_message - Error message for unknown subcommands.
 * @returns Router function.
 */
export const create_subcommand_router = <TContext>(
	routes: Record<string, SubcommandRoute<TContext>>,
	default_handler: ((ctx: TContext, flags: ZzzGlobalArgs) => Promise<void>) | undefined,
	error_message: string,
): ((remaining: ParsedArgs, ctx: TContext, flags: ZzzGlobalArgs) => Promise<void>) => {
	return async (remaining: ParsedArgs, ctx: TContext, flags: ZzzGlobalArgs): Promise<void> => {
		const subcmd = remaining._[0];

		if (subcmd === undefined) {
			if (default_handler) {
				return default_handler(ctx, flags);
			}
			throw new Error(error_message);
		}

		remaining._.shift();

		const route = routes[subcmd];
		if (!route) {
			throw new Error(error_message);
		}

		return dispatch(remaining, route.schema, (args) => route.handler(ctx, args, flags));
	};
};
