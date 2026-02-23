/**
 * Unified runtime abstraction for zzz CLI operations.
 *
 * Provides all runtime primitives as injectable dependencies.
 * Functions should accept partial interfaces for only what they need.
 *
 * @example
 * ```ts
 * // Function declares only what it needs
 * const load_config = (
 *   runtime: Pick<ZzzRuntime, 'env_get' | 'read_file' | 'stat'>,
 * ) => { ... };
 * ```
 *
 * @module
 */

/**
 * Result of a stat operation.
 */
export interface StatResult {
	is_file: boolean;
	is_directory: boolean;
}

/**
 * Result of executing a command.
 */
export interface ZzzCommandResult {
	success: boolean;
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Unified runtime abstraction for zzz CLI operations.
 *
 * Provides all runtime primitives as injectable dependencies.
 * Functions should accept partial interfaces via `Pick<ZzzRuntime, ...>`.
 */
export interface ZzzRuntime {
	// === Environment ===

	/**
	 * Get an environment variable value.
	 *
	 * @param name - Variable name.
	 * @returns Variable value or undefined if not set.
	 */
	env_get: (name: string) => string | undefined;

	/**
	 * Set an environment variable.
	 *
	 * @param name - Variable name.
	 * @param value - Variable value.
	 */
	env_set: (name: string, value: string) => void;

	/**
	 * Get all environment variables.
	 *
	 * @returns Record of all environment variables.
	 */
	env_all: () => Record<string, string>;

	// === Process ===

	/**
	 * CLI arguments passed to the program.
	 */
	readonly args: ReadonlyArray<string>;

	/**
	 * Get current working directory.
	 *
	 * @returns Absolute path to current working directory.
	 */
	cwd: () => string;

	/**
	 * Exit the process with a code.
	 *
	 * @param code - Exit code (0 = success).
	 */
	exit: (code: number) => never;

	// === Local File System ===

	/**
	 * Get file/directory stats.
	 *
	 * @param path - Path to check.
	 * @returns Stat result or null if path doesn't exist.
	 */
	stat: (path: string) => Promise<StatResult | null>;

	/**
	 * Create a directory.
	 *
	 * @param path - Directory path.
	 * @param options - Options (recursive: create parent dirs).
	 */
	mkdir: (path: string, options?: {recursive?: boolean}) => Promise<void>;

	/**
	 * Read a file as text.
	 *
	 * @param path - File path.
	 * @returns File contents.
	 * @throws If file doesn't exist.
	 */
	read_file: (path: string) => Promise<string>;

	/**
	 * Write text to a file.
	 *
	 * @param path - File path.
	 * @param content - File contents.
	 */
	write_file: (path: string, content: string) => Promise<void>;

	/**
	 * Remove a file or directory.
	 *
	 * @param path - Path to remove.
	 * @param options - Options (recursive: remove directory contents).
	 */
	remove: (path: string, options?: {recursive?: boolean}) => Promise<void>;

	// === Local Commands ===

	/**
	 * Run a command and return the result.
	 *
	 * @param cmd - Command to run.
	 * @param args - Command arguments.
	 * @returns Command result with stdout/stderr.
	 */
	run_command: (cmd: string, args: Array<string>) => Promise<ZzzCommandResult>;

	/**
	 * Run a command with inherited stdout/stderr.
	 *
	 * @param cmd - Command to run.
	 * @param args - Command arguments.
	 * @returns Exit code.
	 */
	run_command_inherit: (cmd: string, args: Array<string>) => Promise<number>;

	// === Terminal I/O ===

	/**
	 * Write bytes to stdout.
	 *
	 * @param data - Bytes to write.
	 * @returns Number of bytes written.
	 */
	stdout_write: (data: Uint8Array) => Promise<number>;

	/**
	 * Read bytes from stdin.
	 *
	 * @param buffer - Buffer to read into.
	 * @returns Number of bytes read, or null on EOF.
	 */
	stdin_read: (buffer: Uint8Array) => Promise<number | null>;
}
