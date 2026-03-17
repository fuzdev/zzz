// Deno FFI bindings for libfuz_pty — PTY spawn/read/write/resize/close/kill/waitpid.
// Loaded via Deno.dlopen() from the fuz_pty Rust crate.

import {join} from 'node:path';
import {existsSync} from 'node:fs';

const LIB_NAME = 'libfuz_pty';

const get_library_path = (): string | null => {
	// dev path: ~/dev/private_fuz/target/release/
	const dev_path = join(
		(Deno as any).env?.get?.('HOME') ?? process.env.HOME ?? '',
		'dev',
		'private_fuz',
		'target',
		'release',
		`${LIB_NAME}.so`,
	);
	if (existsSync(dev_path)) return dev_path;
	return null;
};

const symbols = {
	fuz_pty_spawn: {
		parameters: [
			'buffer', // command
			'usize', // command_len
			'buffer', // args_buf
			'usize', // args_buf_len
			'buffer', // cwd
			'usize', // cwd_len
			'u16', // cols
			'u16', // rows
			'pointer', // out_pid
		],
		result: 'i32', // master_fd or -1
	},
	fuz_pty_read: {
		parameters: [
			'i32', // master_fd
			'buffer', // buf
			'usize', // buf_len
		],
		result: 'i32', // bytes read, 0 for EAGAIN, -1 for error/EOF
	},
	fuz_pty_write: {
		parameters: [
			'i32', // master_fd
			'buffer', // buf
			'usize', // buf_len
		],
		result: 'i32', // bytes written or -1
	},
	fuz_pty_resize: {
		parameters: [
			'i32', // master_fd
			'u16', // cols
			'u16', // rows
		],
		result: 'i32', // 0 or -1
	},
	fuz_pty_close: {
		parameters: ['i32'], // master_fd
		result: 'i32', // 0 or -1
	},
	fuz_pty_kill: {
		parameters: [
			'i32', // pid
			'i32', // signal
		],
		result: 'i32', // 0 or -1
	},
	fuz_pty_waitpid: {
		parameters: [
			'i32', // pid
			'pointer', // out_status
		],
		result: 'i32', // pid, 0, or -1
	},
} as const;

type PtyLib = Deno.DynamicLibrary<typeof symbols>;

let lib: PtyLib | null = null;
let ffi_available: boolean | null = null;

const ensure_lib = (): PtyLib => {
	if (lib) return lib;
	const path = get_library_path();
	if (!path) {
		throw new Error('libfuz_pty not found — run: cargo build -p fuz_pty --release');
	}
	lib = Deno.dlopen(path, symbols);
	return lib;
};

/**
 * Check if the FFI library is available.
 */
export const is_ffi_available = (): boolean => {
	if (ffi_available !== null) return ffi_available;
	try {
		ensure_lib();
		ffi_available = true;
	} catch {
		ffi_available = false;
	}
	return ffi_available;
};

const encoder = new TextEncoder();

export interface PtySpawnResult {
	pid: number;
	master_fd: number;
}

/**
 * Spawn a process in a new PTY.
 */
export const pty_spawn = (
	command: string,
	args: Array<string>,
	cwd?: string,
	cols = 80,
	rows = 24,
): PtySpawnResult => {
	const l = ensure_lib();

	const command_buf = encoder.encode(command);
	const args_joined = args.join('\n');
	const args_buf = args_joined.length > 0 ? encoder.encode(args_joined) : new Uint8Array(0);
	const cwd_buf = cwd ? encoder.encode(cwd) : new Uint8Array(0);

	// allocate 4 bytes for the pid output
	const pid_buf = new Int32Array(1);

	const master_fd = l.symbols.fuz_pty_spawn(
		command_buf,
		BigInt(command_buf.length),
		args_buf,
		BigInt(args_buf.length),
		cwd_buf,
		BigInt(cwd_buf.length),
		cols,
		rows,
		Deno.UnsafePointer.of(pid_buf),
	);

	if (master_fd < 0) {
		throw new Error(`fuz_pty_spawn failed for command: ${command}`);
	}

	return {pid: pid_buf[0]!, master_fd};
};

const READ_BUF_SIZE = 16384;
const read_buf = new Uint8Array(READ_BUF_SIZE);

/**
 * Read available data from the PTY. Returns null when no data (EAGAIN) or on EOF/error.
 */
export const pty_read = (master_fd: number): Uint8Array | null => {
	const l = ensure_lib();
	const n = l.symbols.fuz_pty_read(master_fd, read_buf, BigInt(READ_BUF_SIZE));
	if (n <= 0) return null; // 0 = EAGAIN, -1 = error/EOF
	return read_buf.slice(0, n);
};

/**
 * Read from PTY, distinguishing EAGAIN (no data yet) from EOF/error.
 * Returns: bytes read (Uint8Array), 'eagain', or 'eof'.
 */
export const pty_read_status = (
	master_fd: number,
): Uint8Array | 'eagain' | 'eof' => {
	const l = ensure_lib();
	const n = l.symbols.fuz_pty_read(master_fd, read_buf, BigInt(READ_BUF_SIZE));
	if (n > 0) return read_buf.slice(0, n);
	if (n === 0) return 'eagain';
	return 'eof';
};

/**
 * Write data to the PTY.
 */
export const pty_write = (master_fd: number, data: Uint8Array): number => {
	const l = ensure_lib();
	const n = l.symbols.fuz_pty_write(master_fd, data as Uint8Array<ArrayBuffer>, BigInt(data.length));
	if (n < 0) {
		throw new Error('fuz_pty_write failed');
	}
	return n;
};

/**
 * Resize the PTY window.
 */
export const pty_resize = (master_fd: number, cols: number, rows: number): void => {
	const l = ensure_lib();
	const ret = l.symbols.fuz_pty_resize(master_fd, cols, rows);
	if (ret < 0) {
		throw new Error('fuz_pty_resize failed');
	}
};

/**
 * Close the PTY master fd.
 */
export const pty_close = (master_fd: number): void => {
	const l = ensure_lib();
	l.symbols.fuz_pty_close(master_fd);
};

const SIGTERM = 15;
const SIGKILL = 9;

/**
 * Send a signal to a process. Defaults to SIGTERM.
 */
export const pty_kill = (pid: number, signal = SIGTERM): void => {
	const l = ensure_lib();
	l.symbols.fuz_pty_kill(pid, signal);
};

export interface PtyWaitResult {
	exited: boolean;
	status: number;
}

/**
 * Non-blocking waitpid. Returns whether the process has exited and its status.
 */
export const pty_waitpid = (pid: number): PtyWaitResult => {
	const l = ensure_lib();
	const status_buf = new Int32Array(1);
	const ret = l.symbols.fuz_pty_waitpid(pid, Deno.UnsafePointer.of(status_buf));
	if (ret > 0) {
		return {exited: true, status: status_buf[0]!};
	}
	return {exited: false, status: 0};
};

export {SIGTERM, SIGKILL};

/**
 * @module
 */
