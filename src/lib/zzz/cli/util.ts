/**
 * CLI utilities for zzz.
 *
 * @module
 */

import type {ZzzRuntime, ZzzCommandResult} from '../runtime/types.ts';

export const colors = {
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	red: '\x1b[31m',
	cyan: '\x1b[36m',
	dim: '\x1b[2m',
	bold: '\x1b[1m',
	reset: '\x1b[0m',
} as const;

export const log = {
	info: (msg: string): void => console.log(msg),
	success: (msg: string): void => console.log(`${colors.green}[done]${colors.reset} ${msg}`),
	warn: (msg: string): void => console.log(`${colors.yellow}[warn]${colors.reset} ${msg}`),
	error: (msg: string): void => console.log(`${colors.red}[error]${colors.reset} ${msg}`),
	step: (msg: string): void => console.log(`\n${colors.cyan}==>${colors.reset} ${msg}`),
	dim: (msg: string): void => console.log(`${colors.dim}${msg}${colors.reset}`),
};

/**
 * Run a local command and return stdout.
 *
 * @param runtime - Runtime with run_command capability.
 * @param command - Command to run.
 * @param args - Command arguments.
 * @returns Command result.
 */
export const run_local = async (
	runtime: Pick<ZzzRuntime, 'run_command'>,
	command: string,
	args: Array<string>,
): Promise<ZzzCommandResult> => {
	return runtime.run_command(command, args);
};

/**
 * Prompt for yes/no confirmation.
 *
 * @param runtime - Runtime with stdout_write and stdin_read capabilities.
 * @param message - Message to display.
 * @returns `true` if user confirms, `false` otherwise.
 */
export const confirm = async (
	runtime: Pick<ZzzRuntime, 'stdout_write' | 'stdin_read'>,
	message: string,
): Promise<boolean> => {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	await runtime.stdout_write(encoder.encode(`${message} [y/N] `));

	const buf = new Uint8Array(1024);
	const n = await runtime.stdin_read(buf);
	if (n === null) return false;

	const input = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
	return input === 'y' || input === 'yes';
};
