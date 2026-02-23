/**
 * Per-command Zod schemas for CLI argument validation.
 *
 * Centralized here to avoid importing runtime deps (e.g., server_deno.ts)
 * when only schemas are needed (e.g., for help generation).
 *
 * @module
 */

import {z} from 'zod';

/**
 * Init command arguments.
 */
export const InitArgs = z.strictObject({
	_: z.array(z.string()).max(0).default([]),
	port: z.number().optional().meta({description: 'daemon port (default: 4460)'}),
});
export type InitArgs = z.infer<typeof InitArgs>;

/**
 * Daemon start arguments.
 */
export const DaemonStartArgs = z.strictObject({
	_: z.array(z.string()).max(0).default([]),
	port: z.number().optional().meta({description: 'port (overrides config)'}),
	host: z.string().optional().meta({description: 'host (overrides config)'}),
});
export type DaemonStartArgs = z.infer<typeof DaemonStartArgs>;

/**
 * Daemon stop arguments.
 */
export const DaemonStopArgs = z.strictObject({
	_: z.array(z.string()).max(0).default([]),
});
export type DaemonStopArgs = z.infer<typeof DaemonStopArgs>;

/**
 * Daemon status arguments.
 */
export const DaemonStatusArgs = z.strictObject({
	_: z.array(z.string()).max(0).default([]),
	json: z.boolean().default(false).meta({description: 'output as JSON'}),
});
export type DaemonStatusArgs = z.infer<typeof DaemonStatusArgs>;

/**
 * Status command arguments.
 */
export const StatusArgs = z.strictObject({
	_: z.array(z.string()).max(0).default([]),
	json: z.boolean().default(false).meta({description: 'output as JSON'}),
});
export type StatusArgs = z.infer<typeof StatusArgs>;

/**
 * Open command arguments (default command).
 *
 * Handles: `zzz`, `zzz <file>`, `zzz <dir>`.
 */
export const OpenArgs = z.strictObject({
	_: z.array(z.string()).max(1).default([]).meta({description: '[path]'}),
});
export type OpenArgs = z.infer<typeof OpenArgs>;
