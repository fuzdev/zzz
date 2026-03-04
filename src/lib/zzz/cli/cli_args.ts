/**
 * CLI argument parsing utilities for zzz.
 *
 * Provides zzz-specific dispatch and subcommand routing.
 * Generic parsing utilities come from `@fuzdev/fuz_app/cli/args.js`.
 *
 * @module
 */

import type {ParsedArgs} from '@fuzdev/fuz_util/args.js';
import {z} from 'zod';
import {
	parse_command_args,
	create_extract_global_flags,
	type ParseResult,
} from '@fuzdev/fuz_app/cli/args.js';

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

/**
 * Extract global flags from parsed args.
 */
export const extract_global_flags = create_extract_global_flags(ZzzGlobalArgs, {
	help: false,
	version: false,
});

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
