/**
 * Deno implementation of ZzzRuntime.
 *
 * @module
 */

import type {ZzzRuntime, ZzzCommandResult, StatResult} from './types.ts';

/**
 * Create a ZzzRuntime backed by Deno APIs.
 *
 * @param args - CLI arguments (typically Deno.args).
 * @returns ZzzRuntime implementation using Deno runtime.
 */
export const create_deno_runtime = (args: ReadonlyArray<string>): ZzzRuntime => ({
	// === Environment ===
	env_get: (name) => Deno.env.get(name),
	env_set: (name, value) => Deno.env.set(name, value),
	env_all: () => Deno.env.toObject(),

	// === Process ===
	args,
	cwd: () => Deno.cwd(),
	exit: (code) => Deno.exit(code),

	// === Local File System ===
	stat: async (path): Promise<StatResult | null> => {
		try {
			const s = await Deno.stat(path);
			return {is_file: s.isFile, is_directory: s.isDirectory};
		} catch {
			return null;
		}
	},
	mkdir: (path, options) => Deno.mkdir(path, options),
	read_file: (path) => Deno.readTextFile(path),
	write_file: (path, content) => Deno.writeTextFile(path, content),
	remove: (path, options) => Deno.remove(path, options),

	// === Local Commands ===
	run_command: async (cmd, args): Promise<ZzzCommandResult> => {
		try {
			const proc = new Deno.Command(cmd, {
				args,
				stdout: 'piped',
				stderr: 'piped',
			});
			const result = await proc.output();
			return {
				success: result.code === 0,
				code: result.code,
				stdout: new TextDecoder().decode(result.stdout),
				stderr: new TextDecoder().decode(result.stderr),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				code: 1,
				stdout: '',
				stderr: `Failed to execute command: ${message}`,
			};
		}
	},
	run_command_inherit: async (cmd, args): Promise<number> => {
		const proc = new Deno.Command(cmd, {
			args,
			stdout: 'inherit',
			stderr: 'inherit',
		});
		const result = await proc.output();
		return result.code;
	},

	// === Terminal I/O ===
	stdout_write: (data) => Deno.stdout.write(data),
	stdin_read: (buffer) => Deno.stdin.read(buffer),
});
