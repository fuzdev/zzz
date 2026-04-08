import {test, vi, beforeEach, describe, assert} from 'vitest';
import * as fs from 'node:fs/promises';

import {ScopedFs, PathNotAllowedError, SymlinkNotAllowedError} from '$lib/server/scoped_fs.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	rm: vi.fn(),
	mkdir: vi.fn(),
	readdir: vi.fn(),
	stat: vi.fn(),
	lstat: vi.fn(),
	copyFile: vi.fn(),
	access: vi.fn(),
}));

// Test constants
const TEST_ALLOWED_PATHS = ['/allowed/path', '/allowed/other/path/', '/another/allowed/directory'];
const FILE_PATHS = {
	ALLOWED: '/allowed/path/file.txt',
	OUTSIDE: '/not/allowed/file.txt',
	SYMLINK: '/allowed/path/symlink.txt',
	PARENT_SYMLINK: '/allowed/path/symlink-dir/file.txt',
	TRAVERSAL_SIMPLE: '/allowed/path/../../../etc/passwd',
	TRAVERSAL_COMPLEX: '/allowed/path/subdir/.././../../etc/passwd',
	TRAVERSAL_MIXED: '/allowed/path/./foo/../../etc/passwd',
};
const DIR_PATHS = {
	ALLOWED: '/allowed/path/dir',
	OUTSIDE: '/not/allowed/dir',
	SYMLINK_DIR: '/allowed/path/symlink-dir',
	PARENT_SYMLINK_DIR: '/allowed/path/symlink-parent/subdir',
	GRANDPARENT_SYMLINK_DIR: '/allowed/path/normal-dir/symlink-parent/subdir',
};

const create_test_instance = () => new ScopedFs(TEST_ALLOWED_PATHS);

beforeEach(() => {
	vi.clearAllMocks();

	// Default lstat mock returning a non-symlink file
	vi.mocked(fs.lstat).mockImplementation(() =>
		Promise.resolve({
			isSymbolicLink: () => false,
			isDirectory: () => false,
			isFile: () => true,
		} as any),
	);
});

describe('ScopedFs - symlink security', () => {
	test('should reject symlinks in target path', async () => {
		const scoped_fs = create_test_instance();

		// Setup target path as a symlink
		vi.mocked(fs.lstat).mockImplementationOnce(() =>
			Promise.resolve({
				isSymbolicLink: () => true,
				isDirectory: () => false,
				isFile: () => false,
			} as any),
		);

		// All operations should reject symlinks EXCEPT exists()
		const operations = [
			() => scoped_fs.read_file(FILE_PATHS.SYMLINK),
			() => scoped_fs.write_file(FILE_PATHS.SYMLINK, 'content'),
			() => scoped_fs.stat(FILE_PATHS.SYMLINK),
			() => scoped_fs.copy_file(FILE_PATHS.ALLOWED, FILE_PATHS.SYMLINK),
			() => scoped_fs.copy_file(FILE_PATHS.SYMLINK, FILE_PATHS.ALLOWED),
			// exists() has been removed from this list as it should return false, not throw
		];

		for (const operation of operations) {
			vi.mocked(fs.lstat).mockClear();
			vi.mocked(fs.lstat).mockImplementationOnce(() =>
				Promise.resolve({
					isSymbolicLink: () => true,
					isDirectory: () => false,
					isFile: () => false,
				} as any),
			);

			try {
				await operation();
				assert.fail('Expected error to be thrown');
			} catch (e) {
				assert.instanceOf(e, SymlinkNotAllowedError);
			}
		}

		// Test exists() separately
		vi.mocked(fs.lstat).mockClear();
		vi.mocked(fs.lstat).mockImplementationOnce(() =>
			Promise.resolve({
				isSymbolicLink: () => true,
				isDirectory: () => false,
				isFile: () => false,
			} as any),
		);

		const exists = await scoped_fs.exists(FILE_PATHS.SYMLINK);
		assert.ok(!exists);
	});

	test('should reject symlinks in parent directories', async () => {
		const scoped_fs = create_test_instance();

		// Setup mocks to simulate a parent directory that is a symlink
		vi.mocked(fs.lstat).mockImplementation(async (path) => {
			// The file itself is not a symlink
			if (String(path) === FILE_PATHS.PARENT_SYMLINK) {
				return {
					isSymbolicLink: () => false,
					isDirectory: () => false,
					isFile: () => true,
				} as any;
			}

			// But the parent directory is a symlink
			if (String(path).includes('symlink-dir')) {
				return {
					isSymbolicLink: () => true,
					isDirectory: () => true,
					isFile: () => false,
				} as any;
			}

			// Other paths are normal
			return {
				isSymbolicLink: () => false,
				isDirectory: () => String(path).includes('dir'),
				isFile: () => !String(path).includes('dir'),
			} as any;
		});

		// Should throw for any operation on a file in a symlinked parent directory
		try {
			await scoped_fs.read_file(FILE_PATHS.PARENT_SYMLINK);
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, SymlinkNotAllowedError);
		}

		// Should also throw for mkdir in a symlinked directory
		try {
			await scoped_fs.mkdir('/allowed/path/symlink-dir/subdir');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, SymlinkNotAllowedError);
		}
	});

	test('should reject symlinks in grandparent directories', async () => {
		const scoped_fs = create_test_instance();

		// Create more complex directory structure with symlink in grandparent
		const path_parts = DIR_PATHS.GRANDPARENT_SYMLINK_DIR.split('/');
		const paths_to_check = [];

		// Build path hierarchy
		let current_path = '';
		for (const part of path_parts) {
			if (!part) continue; // Skip empty strings from split
			current_path += '/' + part;
			paths_to_check.push(current_path);
		}

		// Setup lstat to find symlink at specific level
		vi.mocked(fs.lstat).mockImplementation(async (path) => {
			// Make one specific path a symlink - the 'symlink-parent' directory
			if (path === '/allowed/path/normal-dir/symlink-parent') {
				return {
					isSymbolicLink: () => true,
					isDirectory: () => true,
					isFile: () => false,
				} as any;
			}
			// All other paths are normal
			return {
				isSymbolicLink: () => false,
				isDirectory: () => path.toString().includes('dir'),
				isFile: () => !path.toString().includes('dir'),
			} as any;
		});

		// Should detect the symlink even when it's not the immediate parent
		try {
			await scoped_fs.read_file(`${DIR_PATHS.GRANDPARENT_SYMLINK_DIR}/file.txt`);
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, SymlinkNotAllowedError);
		}
	});

	test('should detect symlinks consistently across all operations', async () => {
		const scoped_fs = create_test_instance();

		// Create a file system structure where a particular directory is a symlink
		const symlink_dir = '/allowed/path/sneaky-symlink-dir';
		const file_in_symlink = `${symlink_dir}/file.txt`;

		// Setup lstat to mark the directory as a symlink
		vi.mocked(fs.lstat).mockImplementation(async (path) => {
			if (path === symlink_dir) {
				return {
					isSymbolicLink: () => true,
					isDirectory: () => true,
					isFile: () => false,
				} as any;
			}
			return {
				isSymbolicLink: () => false,
				isDirectory: () => path.toString().includes('dir'),
				isFile: () => !path.toString().includes('dir'),
			} as any;
		});

		// Test multiple operations to ensure consistent detection
		const operations = [
			() => scoped_fs.read_file(file_in_symlink),
			() => scoped_fs.write_file(file_in_symlink, 'content'),
			() => scoped_fs.mkdir(`${symlink_dir}/subdir`),
			() => scoped_fs.readdir(symlink_dir),
			() => scoped_fs.stat(file_in_symlink),
			() => scoped_fs.rm(file_in_symlink),
		];

		// All operations should detect the symlink
		for (const operation of operations) {
			try {
				await operation();
				assert.fail('Expected error to be thrown');
			} catch (e) {
				assert.instanceOf(e, SymlinkNotAllowedError);
			}
		}
	});

	test('exists() should return false for symlinks', async () => {
		const scoped_fs = create_test_instance();

		// Setup target path as symlink
		vi.mocked(fs.lstat).mockImplementationOnce(() =>
			Promise.resolve({
				isSymbolicLink: () => true,
				isDirectory: () => false,
				isFile: () => false,
			} as any),
		);

		// Should return false rather than throwing for exists()
		const result = await scoped_fs.exists(FILE_PATHS.SYMLINK);
		assert.ok(!result);

		// access should not be called since the symlink is detected first
		assert.strictEqual(vi.mocked(fs.access).mock.calls.length, 0);
	});

	test('is_path_safe should return false for symlinks', async () => {
		const scoped_fs = create_test_instance();

		// Setup a sequence of symlink checks for different paths
		const symlink_scenarios = [
			{path: FILE_PATHS.SYMLINK, symlink_at: FILE_PATHS.SYMLINK},
			{path: FILE_PATHS.PARENT_SYMLINK, symlink_at: '/allowed/path/symlink-dir'},
		];

		for (const {path, symlink_at} of symlink_scenarios) {
			vi.mocked(fs.lstat).mockReset();

			// Setup custom lstat implementation for this scenario
			vi.mocked(fs.lstat).mockImplementation(async (p) => {
				if (p === symlink_at) {
					return {
						isSymbolicLink: () => true,
						isDirectory: () => p.endsWith('dir'),
						isFile: () => !p.endsWith('dir'),
					} as any;
				}
				return {
					isSymbolicLink: () => false,
					isDirectory: () => p.toString().includes('dir'),
					isFile: () => !p.toString().includes('dir'),
				} as any;
			});

			// Should safely return false without throwing
			const is_safe = await scoped_fs.is_path_safe(path);
			assert.ok(!is_safe);
		}
	});
});

describe('ScopedFs - null byte rejection', () => {
	test('should reject paths containing null bytes', () => {
		const scoped_fs = create_test_instance();

		const null_byte_paths = [
			'/allowed/path/\0file.txt',
			'/allowed/path/file\0.txt',
			'/allowed/path/\0../../etc/passwd',
		];

		for (const path of null_byte_paths) {
			assert.ok(!scoped_fs.is_path_allowed(path));
		}
	});

	test('should throw PathNotAllowedError for null byte paths in operations', async () => {
		const scoped_fs = create_test_instance();

		try {
			await scoped_fs.read_file('/allowed/path/\0file.txt');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, PathNotAllowedError);
		}

		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 0);
	});
});

describe('ScopedFs - path traversal security', () => {
	test('should reject standard path traversal attempts', async () => {
		const scoped_fs = create_test_instance();

		const traversal_paths = [
			FILE_PATHS.TRAVERSAL_SIMPLE,
			FILE_PATHS.TRAVERSAL_COMPLEX,
			FILE_PATHS.TRAVERSAL_MIXED,
			'/allowed/path/../not-allowed/file.txt',
			'/allowed/path/subdir/../../not-allowed/file.txt',
		];

		// Check both synchronous and asynchronous validation
		for (const path of traversal_paths) {
			// Synchronous check should fail
			assert.ok(!scoped_fs.is_path_allowed(path));

			// Async checks should also fail
			assert.ok(!(await scoped_fs.is_path_safe(path)));

			// Operations should throw
			try {
				await scoped_fs.read_file(path);
				assert.fail('Expected error to be thrown');
			} catch (e) {
				assert.instanceOf(e, PathNotAllowedError);
			}
		}
	});

	test('backslashes are literal on POSIX and do not enable traversal', () => {
		const scoped_fs = create_test_instance();

		// On POSIX, backslash is a valid filename character, not a separator.
		// normalize leaves it as-is, so this is a literal path segment, not traversal.
		const backslash_path = '/allowed/path\\..\\..\\Windows\\System32\\config\\sam';
		assert.ok(!scoped_fs.is_path_allowed(backslash_path));
	});

	test('fullwidth Unicode lookalikes are literal characters, not traversal', () => {
		const scoped_fs = create_test_instance();

		// Fullwidth ．．is NOT .. — normalize treats it as a regular directory name
		const unicode_path = '/allowed/path/ＮＮ/．．/．．/etc/passwd';
		// This stays inside /allowed/path/ after normalization, so it IS allowed
		assert.ok(scoped_fs.is_path_allowed(unicode_path));
	});

	test('should safely normalize legitimate paths', async () => {
		const scoped_fs = create_test_instance();

		// These paths look suspicious but normalize to allowed paths
		const legitimate_paths = [
			'/allowed/path/./file.txt', // With current dir
			'/allowed/path/subdir/../file.txt', // With parent dir that stays in allowed zone
			'/allowed/path//file.txt', // Double slash
			'/allowed/path/subdir/./other/../file.txt', // Complex but legal
		];

		for (const path of legitimate_paths) {
			assert.ok(scoped_fs.is_path_allowed(path));
			assert.ok(await scoped_fs.is_path_safe(path));

			// Mock successful read
			vi.mocked(fs.readFile).mockReset();
			vi.mocked(fs.readFile).mockResolvedValueOnce('content' as any);

			// Should allow operations on these paths
			const content = await scoped_fs.read_file(path);
			assert.strictEqual(content, 'content');
		}
	});
});

describe('ScopedFs - access control security', () => {
	test('should enforce strict path boundaries', async () => {
		const scoped_fs = create_test_instance();

		const boundary_test_cases = [
			// Just outside allowed path boundary
			{path: '/allowed', allowed: false},
			{path: '/allowed-path', allowed: false},
			{path: '/allowed/pat', allowed: false},

			// Path containment attempts
			{path: '/allowed/path.secret', allowed: false},
			{path: '/allowed/pathextra', allowed: false},
			{path: '/allowed/path_extra', allowed: false},

			// Just inside allowed path boundary
			{path: '/allowed/path', allowed: true},
			{path: '/allowed/path/', allowed: true},
			{path: '/allowed/path/file', allowed: true},
		];

		for (const {path, allowed} of boundary_test_cases) {
			assert.strictEqual(scoped_fs.is_path_allowed(path), allowed);

			// For valid paths, mock a successful read
			if (allowed) {
				vi.mocked(fs.readFile).mockReset();
				vi.mocked(fs.readFile).mockResolvedValueOnce('content' as any);
				const content = await scoped_fs.read_file(path);
				assert.strictEqual(content, 'content');
			} else {
				try {
					await scoped_fs.read_file(path);
					assert.fail('Expected error to be thrown');
				} catch (e) {
					assert.instanceOf(e, PathNotAllowedError);
				}
			}
		}
	});

	test('should properly handle root directory permissions', async () => {
		// Create instance with root as allowed path
		const root_scoped_fs = new ScopedFs(['/']);

		// Should allow any path
		const root_test_paths = [
			'/',
			'/etc',
			'/etc/passwd',
			'/usr/bin',
			'/var/log/auth.log',
			'/home/user/secret.txt',
		];

		for (const path of root_test_paths) {
			assert.ok(root_scoped_fs.is_path_allowed(path));

			// Mock successful read
			vi.mocked(fs.readFile).mockReset();
			vi.mocked(fs.readFile).mockResolvedValueOnce('content' as any);

			// Should allow operations
			const content = await root_scoped_fs.read_file(path);
			assert.strictEqual(content, 'content');
		}

		// Non-absolute paths should still be rejected
		assert.ok(!root_scoped_fs.is_path_allowed('relative/path'));
		try {
			await root_scoped_fs.read_file('relative/path');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, PathNotAllowedError);
		}
	});

	test('should properly isolate between allowed paths', async () => {
		// Create instance with multiple distinct allowed paths
		const complex_scoped_fs = new ScopedFs(['/home/user1/data', '/var/app/logs']);

		// Paths that should be allowed
		const allowed_paths = [
			'/home/user1/data/file.txt',
			'/home/user1/data/subdir/config.json',
			'/var/app/logs/app.log',
			'/var/app/logs/errors/fatal.log',
		];

		// Paths that should be rejected
		const disallowed_paths = [
			'/home/user2/data/file.txt', // Different user
			'/home/user1/documents/file.txt', // Different directory
			'/var/app/config/settings.json', // Outside logs
			'/var/log/system.log', // Different path
			'/home/user1/data/../private/secret.txt', // Traversal
			'/var/app/logs/../config/settings.json', // Traversal
		];

		// Check allowed paths
		for (const path of allowed_paths) {
			assert.ok(complex_scoped_fs.is_path_allowed(path));
		}

		// Check disallowed paths
		for (const path of disallowed_paths) {
			assert.ok(!complex_scoped_fs.is_path_allowed(path));
			try {
				await complex_scoped_fs.read_file(path);
				assert.fail('Expected error to be thrown');
			} catch (e) {
				assert.instanceOf(e, PathNotAllowedError);
			}
		}
	});

	test('should reject operations with empty path', async () => {
		const scoped_fs = create_test_instance();

		// Empty path should be rejected by all operations
		for (const operation of [
			() => scoped_fs.read_file(''),
			() => scoped_fs.write_file('', 'content'),
			() => scoped_fs.stat(''),
			() => scoped_fs.mkdir(''),
			() => scoped_fs.readdir(''),
		]) {
			try {
				await operation();
				assert.fail('Expected error to be thrown');
			} catch (e) {
				assert.instanceOf(e, PathNotAllowedError);
			}
		}

		// exists() should return false for empty path
		assert.ok(!(await scoped_fs.exists('')));
	});

	test('copy_file should validate both source and destination paths', async () => {
		const scoped_fs = create_test_instance();

		// All valid combinations
		await scoped_fs.copy_file('/allowed/path/source.txt', '/allowed/path/dest.txt');
		await scoped_fs.copy_file('/allowed/path/source.txt', '/allowed/other/path/dest.txt');

		// Invalid source
		try {
			await scoped_fs.copy_file('/not/allowed/source.txt', '/allowed/path/dest.txt');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, PathNotAllowedError);
		}

		// Invalid destination
		try {
			await scoped_fs.copy_file('/allowed/path/source.txt', '/not/allowed/dest.txt');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, PathNotAllowedError);
		}

		// Both invalid
		try {
			await scoped_fs.copy_file('/not/allowed/source.txt', '/not/allowed/dest.txt');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, PathNotAllowedError);
		}

		// Path traversal in source
		try {
			await scoped_fs.copy_file('/allowed/path/../../../etc/passwd', '/allowed/path/dest.txt');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, PathNotAllowedError);
		}

		// Path traversal in destination
		try {
			await scoped_fs.copy_file('/allowed/path/source.txt', '/allowed/path/../../../etc/passwd');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, PathNotAllowedError);
		}
	});
});

describe('ScopedFs - security error handling', () => {
	test('PathNotAllowedError should properly format path in message', () => {
		const test_paths = [
			'/etc/passwd',
			'/var/log/auth.log',
			'/home/user/secret.txt',
			'relative/path',
			'../another/path',
			'', // Empty string
		];

		for (const path of test_paths) {
			const error = new PathNotAllowedError(path);
			assert.strictEqual(error.message, `Path is not allowed: ${path}`);
			assert.strictEqual(error.name, 'PathNotAllowedError');
		}
	});

	test('SymlinkNotAllowedError should properly format path in message', () => {
		const test_paths = ['/allowed/path/symlink', '/allowed/path/symlink-dir'];

		for (const path of test_paths) {
			const error = new SymlinkNotAllowedError(path);
			assert.strictEqual(error.message, `Path is a symlink which is not allowed: ${path}`);
			assert.strictEqual(error.name, 'SymlinkNotAllowedError');
		}
	});

	test('should handle filesystem errors during security checks gracefully', async () => {
		const scoped_fs = create_test_instance();

		// Setup a filesystem error during symlink check
		vi.mocked(fs.lstat).mockRejectedValueOnce(new Error('Permission denied'));

		// Should throw the filesystem error, not a security error
		try {
			await scoped_fs.read_file(FILE_PATHS.ALLOWED);
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'Permission denied');
		}
		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 0);
	});
});
