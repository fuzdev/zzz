import * as fs from 'node:fs/promises';
import type * as fs_types from 'node:fs';
import {dirname, normalize} from 'node:path';
import {ensure_end} from '@fuzdev/fuz_util/string.js';
import {z} from 'zod';

// TODO probably need configuration to e.g. allow symlinks, this starting point prioritizes locking things down

// TODO add `filter` option, by default ignore at least .env,  maybe all of .gitignore - what should be readable/writable?

/**
 * A branded type for representing safely normalized filesystem paths
 */
export const ScopedFsPath = z
	.string()
	.refine((p) => p.startsWith('/'), {message: 'Path must be absolute'})
	.transform((p) => normalize(p.trim()))
	.brand('ScopedFsPath');
export type ScopedFsPath = z.infer<typeof ScopedFsPath>;

/**
 * Provides a secure wrapper around filesystem operations to prevent path traversal attacks and
 * unauthorized file access.
 *
 * Security features:
 * - Restricts operations to specified allowed paths
 * - Prevents path traversal attacks by normalizing all paths
 * - Blocks access to symlinks to avoid arbitrary file access
 * - Requires absolute paths to avoid relative path confusion
 * - Validates the entire path hierarchy for each operation
 *
 * `ScopedFs` should be used whenever performing filesystem operations on
 * user-provided or untrusted input paths to ensure proper access boundaries.
 */
export class ScopedFs {
	readonly allowed_paths: ReadonlyArray<ScopedFsPath>;

	/**
	 * Create a new ScopedFs instance with the specified allowed paths.
	 * @param allowed_paths - array of absolute paths that operations will be restricted to
	 */
	constructor(allowed_paths: Array<string> | ReadonlyArray<string>) {
		try {
			this.allowed_paths = Object.freeze(
				allowed_paths.filter(Boolean).map((p) => ScopedFsPath.parse(ensure_end(p, '/'))),
			);
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw new Error(`Invalid path in allowed_paths: ${error.message}`);
			}
			throw error;
		}
	}

	/**
	 * Checks if the given path is allowed based on the paths provided during instantiation.
	 */
	is_path_allowed(path_to_check: string): boolean {
		if (!path_to_check) return false;

		try {
			// Let the parser normalize and validate - this handles absolute path requirement
			// and normalizes all path traversal attempts
			const normalized_path = ScopedFsPath.parse(path_to_check);

			// Check if within allowed paths
			for (const allowed_path of this.allowed_paths) {
				if (!allowed_path) continue;

				if (
					// Root directory is special
					(allowed_path === '/' && normalized_path.startsWith('/')) ||
					// Direct path match
					normalized_path === allowed_path ||
					// Path is inside directory (allowed_path already has trailing slash)
					normalized_path.startsWith(allowed_path) ||
					// Handle case where path equals directory but without trailing slash
					// e.g., '/dir' matches '/dir/'
					normalized_path === allowed_path.slice(0, -1)
				) {
					return true;
				}
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Performs a complete security check on a path, including symlink validation
	 */
	async is_path_safe(path_to_check: string): Promise<boolean> {
		try {
			await this.#ensure_safe_path(path_to_check);
			return true;
		} catch {
			return false;
		}
	}

	async read_file(
		file_path: string,
		options: Parameters<typeof fs.readFile>[1] = 'utf8',
	): Promise<Buffer | string> {
		const safe_path = await this.#ensure_safe_path(file_path);
		return fs.readFile(safe_path, options);
	}

	async write_file(
		file_path: string,
		data: Parameters<typeof fs.writeFile>[1],
		options: Parameters<typeof fs.writeFile>[2] = 'utf8',
	): Promise<void> {
		const safe_path = await this.#ensure_safe_path(file_path);
		return fs.writeFile(safe_path, data, options);
	}

	async rm(path_to_remove: string, options?: fs_types.RmOptions): Promise<void> {
		const safe_path = await this.#ensure_safe_path(path_to_remove);
		return fs.rm(safe_path, options);
	}

	async mkdir(
		dir_path: string,
		options?: fs_types.MakeDirectoryOptions,
	): Promise<string | undefined> {
		const safe_path = await this.#ensure_safe_path(dir_path);
		return fs.mkdir(safe_path, options);
	}

	async readdir(
		path: fs_types.PathLike,
		options?:
			| (fs_types.ObjectEncodingOptions & {
					withFileTypes?: false | undefined;
					recursive?: boolean | undefined;
			  })
			| BufferEncoding
			| null,
	): Promise<Array<string>>;
	async readdir(
		path: fs_types.PathLike,
		options: fs_types.ObjectEncodingOptions & {
			withFileTypes: true;
			recursive?: boolean | undefined;
		},
	): Promise<Array<fs_types.Dirent>>;
	async readdir(
		dir_path: string,
		options?: fs_types.ObjectEncodingOptions | BufferEncoding | null,
	): Promise<Array<fs_types.Dirent> | Array<string>> {
		const safe_path = await this.#ensure_safe_path(dir_path);
		return fs.readdir(safe_path, options);
	}

	async stat(path_to_stat: string, options?: fs_types.StatOptions): Promise<fs_types.Stats>;
	async stat(path_to_stat: string, options: fs_types.StatOptions): Promise<fs_types.BigIntStats>;
	async stat(
		path_to_stat: string,
		options?: fs_types.StatOptions,
	): Promise<fs_types.Stats | fs_types.BigIntStats> {
		const safe_path = await this.#ensure_safe_path(path_to_stat);
		return fs.stat(safe_path, options);
	}

	async copy_file(source: string, destination: string, mode?: number): Promise<void> {
		const safe_source = await this.#ensure_safe_path(source);
		const safe_destination = await this.#ensure_safe_path(destination);
		return fs.copyFile(safe_source, safe_destination, mode);
	}

	async exists(path_to_check: string): Promise<boolean> {
		// Instead of throwing for disallowed paths, simply return false.
		if (!this.is_path_allowed(path_to_check)) {
			return false;
		}
		try {
			await this.#ensure_safe_path(path_to_check);
			await fs.access(ScopedFsPath.parse(path_to_check));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Ensures a path is safe by validating it.
	 * Throws an error if the path is not allowed or contains symlinks.
	 */
	async #ensure_safe_path(path_to_check: string): Promise<string> {
		let normalized_path: ScopedFsPath;
		try {
			normalized_path = ScopedFsPath.parse(path_to_check);
		} catch {
			throw new PathNotAllowedError(path_to_check);
		}

		if (!this.is_path_allowed(normalized_path)) {
			throw new PathNotAllowedError(normalized_path);
		}

		// Check the target path if it exists
		try {
			const stats = await fs.lstat(normalized_path);
			if (stats.isSymbolicLink()) {
				throw new SymlinkNotAllowedError(normalized_path);
			}
		} catch (error) {
			// If error is due to non-existence, ignore
			if (!((error as NodeJS.ErrnoException).code === 'ENOENT')) {
				throw error;
			}
		}

		// Check all parent directories
		let current: string = normalized_path;
		while (current !== '/' && current !== '.') {
			const parent = dirname(current);
			if (parent === current) break;

			try {
				const stats = await fs.lstat(parent); // eslint-disable-line no-await-in-loop
				if (stats.isSymbolicLink()) {
					throw new SymlinkNotAllowedError(parent);
				}
			} catch (error) {
				if (!((error as NodeJS.ErrnoException).code === 'ENOENT')) {
					throw error;
				}
			}
			current = parent;
		}
		return normalized_path;
	}
}

/**
 * Error thrown when a path is not allowed
 */
export class PathNotAllowedError extends Error {
	override name = 'PathNotAllowedError' as const;

	constructor(path: string, options?: ErrorOptions) {
		super(`Path is not allowed: ${path}`, options);
	}
}

/**
 * Error thrown when a path is a symlink
 */
export class SymlinkNotAllowedError extends Error {
	override name = 'SymlinkNotAllowedError' as const;

	constructor(path: string, options?: ErrorOptions) {
		super(`Path is a symlink which is not allowed: ${path}`, options);
	}
}
