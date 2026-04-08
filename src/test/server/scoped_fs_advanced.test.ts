import {test, vi, beforeEach, describe, assert} from 'vitest';
import * as fs from 'node:fs/promises';

import {ScopedFs, SymlinkNotAllowedError} from '$lib/server/scoped_fs.js';

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
	NESTED: '/allowed/path/subdir/file.txt',
	OUTSIDE: '/not/allowed/file.txt',
	TRAVERSAL: '/allowed/path/../../../etc/passwd',
	UNICODE: '/allowed/path/файл.txt',
	SPECIAL_CHARS: '/allowed/path/file with spaces!@#.txt',
	NONEXISTENT: '/allowed/path/does-not-exist.txt',
	SYMLINK: '/allowed/path/symlink',
	PARENT_SYMLINK: '/allowed/path/symlink-dir/file.txt',
};
const DIR_PATHS = {
	ALLOWED: '/allowed/path/dir',
	OUTSIDE: '/not/allowed/dir',
	NEW_DIR: '/allowed/path/new-dir',
	SYMLINK: '/allowed/path/symlink-dir',
	NESTED: '/allowed/path/nested/directory/structure',
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

// Helper to create ENOENT error with proper code property
const create_enoent_error = (path: string): NodeJS.ErrnoException => {
	const error = new Error(
		`ENOENT: no such file or directory, lstat '${path}'`,
	) as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	error.errno = -2;
	error.syscall = 'lstat';
	error.path = path;
	return error;
};

// Helper to set up mock filesystem structure
const setup_mock_filesystem = () => {
	const filesystem = {
		'/allowed/path': {isDir: true, isSymlink: false},
		'/allowed/path/file.txt': {isDir: false, isSymlink: false},
		'/allowed/path/dir': {isDir: true, isSymlink: false},
		'/allowed/path/symlink': {isDir: false, isSymlink: true},
		'/allowed/path/symlink-dir': {isDir: true, isSymlink: true},
		'/allowed/path/subdir': {isDir: true, isSymlink: false},
		'/allowed/path/subdir/file.txt': {isDir: false, isSymlink: false},
		'/allowed/path/файл.txt': {isDir: false, isSymlink: false},
		'/allowed/path/file with spaces!@#.txt': {isDir: false, isSymlink: false},
		// Add parent directories to avoid ENOENT during parent checks
		'/allowed': {isDir: true, isSymlink: false},
		'/': {isDir: true, isSymlink: false},
		'/allowed/other': {isDir: true, isSymlink: false},
		'/allowed/other/path': {isDir: true, isSymlink: false},
		'/another': {isDir: true, isSymlink: false},
		'/another/allowed': {isDir: true, isSymlink: false},
		'/another/allowed/directory': {isDir: true, isSymlink: false},
	};

	vi.mocked(fs.lstat).mockImplementation(async (pathStr) => {
		const entry = (filesystem as any)[pathStr as string];
		if (!entry) {
			throw create_enoent_error(pathStr as string);
		}

		return {
			isSymbolicLink: () => entry.isSymlink,
			isDirectory: () => entry.isDir,
			isFile: () => !entry.isDir && !entry.isSymlink,
		} as any;
	});

	return filesystem;
};

describe('ScopedFs - constructor edge cases', () => {
	test('should filter out empty strings and falsy values from allowed paths', () => {
		const paths_with_empty = ['/valid/path', '', '/another/path', '', ''];
		const scoped_fs = new ScopedFs(paths_with_empty);

		// Should only have 2 allowed paths (empty strings filtered)
		assert.strictEqual(scoped_fs.allowed_paths.length, 2);

		// Valid paths should be allowed
		assert.ok(scoped_fs.is_path_allowed('/valid/path/file.txt'));
		assert.ok(scoped_fs.is_path_allowed('/another/path/file.txt'));
	});

	test('should filter out null and undefined values from allowed paths', () => {
		const paths_with_nullish = ['/valid/path', null, '/another/path', undefined] as Array<string>;
		const scoped_fs = new ScopedFs(paths_with_nullish);

		// Should only have 2 allowed paths (nullish values filtered)
		assert.strictEqual(scoped_fs.allowed_paths.length, 2);
	});

	test('should handle array with only empty/falsy values', () => {
		const empty_array = ['', null, undefined, ''] as Array<string>;
		const scoped_fs = new ScopedFs(empty_array);

		// Should have no allowed paths
		assert.strictEqual(scoped_fs.allowed_paths.length, 0);

		// No paths should be allowed
		assert.ok(!scoped_fs.is_path_allowed('/any/path'));
	});
});

describe('ScopedFs - advanced path validation', () => {
	test('should handle paths with special characters correctly', () => {
		const scoped_fs = create_test_instance();

		const special_paths = [
			FILE_PATHS.UNICODE,
			FILE_PATHS.SPECIAL_CHARS,
			'/allowed/path/Å.txt',
			'/allowed/path/🔥.txt',
			'/allowed/path/path with multiple spaces/file.txt',
			'/allowed/path/path-with-dashes/file.txt',
			'/allowed/path/path_with_underscores/file.txt',
		];

		// All should be allowed
		for (const path of special_paths) {
			assert.ok(scoped_fs.is_path_allowed(path));
		}
	});

	test('should handle multiple trailing slashes and normalize paths', () => {
		const scoped_fs = create_test_instance();

		// These paths should all be allowed and normalized internally
		const paths_with_multiple_slashes = [
			'/allowed/path//',
			'/allowed/path//file.txt',
			'/allowed/path////',
			'/allowed/path////file.txt',
		];

		for (const path of paths_with_multiple_slashes) {
			assert.ok(scoped_fs.is_path_allowed(path));
		}
	});

	test('should validate complex path combinations', async () => {
		const scoped_fs = create_test_instance();

		const valid_paths = [
			'/allowed/path',
			'/allowed/path/',
			'/allowed/other/path',
			'/allowed/other/path/',
			'/allowed/path/a/b/c/d/deep/nested/path',
			'/allowed/path/././file.txt', // This will be normalized
		];

		const invalid_paths = [
			'/allowed/pathextra',
			'/allowedpath/file.txt',
			'/allowed/./path/../../../etc/passwd',
			'/allowed/path/../../file.txt',
		];

		// Test valid paths
		for (const path of valid_paths) {
			assert.ok(scoped_fs.is_path_allowed(path));
			assert.ok(await scoped_fs.is_path_safe(path));
		}

		// Test invalid paths
		for (const path of invalid_paths) {
			assert.ok(!scoped_fs.is_path_allowed(path));
			assert.ok(!(await scoped_fs.is_path_safe(path)));
		}
	});
});

describe('ScopedFs - advanced directory operations', () => {
	test('readdir - should handle different option combinations', async () => {
		const scoped_fs = create_test_instance();
		setup_mock_filesystem();

		const readdir_options = [
			null,
			'utf8',
			{},
			{withFileTypes: false},
			{withFileTypes: true},
			{recursive: true},
			{encoding: 'utf8'},
			{withFileTypes: true, recursive: true},
		];

		// Setup mock responses for regular files and Dirent objects
		const files = ['file1.txt', 'file2.txt', 'subdir'];
		const dirents = files.map((name) => ({
			name,
			isFile: () => !name.includes('dir'),
			isDirectory: () => name.includes('dir'),
			isSymbolicLink: () => false,
		}));

		for (const option of readdir_options) {
			vi.mocked(fs.readdir).mockReset();

			if (
				option &&
				typeof option === 'object' &&
				'withFileTypes' in option &&
				option.withFileTypes
			) {
				vi.mocked(fs.readdir).mockResolvedValueOnce(dirents as any);
			} else {
				vi.mocked(fs.readdir).mockResolvedValueOnce(files as any);
			}

			await scoped_fs.readdir(DIR_PATHS.ALLOWED, option as any);
			assert.deepEqual(vi.mocked(fs.readdir).mock.calls[0], [DIR_PATHS.ALLOWED, option] as any);
		}
	});

	test('mkdir - should create nested directory structures', async () => {
		const scoped_fs = create_test_instance();

		// Test creating a deeply nested directory
		await scoped_fs.mkdir(DIR_PATHS.NESTED, {recursive: true});
		assert.deepEqual(vi.mocked(fs.mkdir).mock.calls[0], [DIR_PATHS.NESTED, {recursive: true}]);

		// Without recursive flag, it should still try to create the directory
		await scoped_fs.mkdir(DIR_PATHS.NEW_DIR);
		assert.deepEqual(vi.mocked(fs.mkdir).mock.calls[1], [DIR_PATHS.NEW_DIR, undefined]);

		// Should properly bubble up errors from fs.mkdir
		const error = new Error('EEXIST: directory already exists');
		vi.mocked(fs.mkdir).mockRejectedValueOnce(error);

		try {
			await scoped_fs.mkdir(DIR_PATHS.ALLOWED);
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.strictEqual(e, error);
		}
	});

	test('rm - should handle various removal options', async () => {
		const scoped_fs = create_test_instance();

		const rm_options_combinations = [
			undefined,
			{},
			{recursive: true},
			{force: true},
			{recursive: true, force: true},
		];

		for (const options of rm_options_combinations) {
			vi.mocked(fs.rm).mockReset();
			vi.mocked(fs.rm).mockResolvedValueOnce();

			await scoped_fs.rm(DIR_PATHS.ALLOWED, options);
			assert.deepEqual(vi.mocked(fs.rm).mock.calls[0], [DIR_PATHS.ALLOWED, options]);
		}
	});
});

describe('ScopedFs - advanced security features', () => {
	test('should reject all symlinks in path hierarchy', async () => {
		const scoped_fs = create_test_instance();

		// Setup a virtual file system where different components are symlinks
		const symlink_test_cases = [
			{
				description: 'Target file is a symlink',
				path: FILE_PATHS.SYMLINK,
				symlink_at: FILE_PATHS.SYMLINK,
			},
			{
				description: 'Parent directory is a symlink',
				path: FILE_PATHS.PARENT_SYMLINK,
				symlink_at: '/allowed/path/symlink-dir',
			},
			{
				description: 'Grandparent directory is a symlink',
				path: '/allowed/path/dir/subdir/file.txt',
				symlink_at: '/allowed/path/dir',
			},
		];

		for (const {path, symlink_at} of symlink_test_cases) {
			// Reset mocks for each test case
			vi.mocked(fs.lstat).mockReset();

			// Setup a custom lstat implementation for this test case
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
					isDirectory: () => String(p).includes('dir'),
					isFile: () => !String(p).includes('dir'),
				} as any;
			});

			// Each case should be rejected with a SymlinkNotAllowedError
			try {
				await scoped_fs.read_file(path);
				assert.fail('Expected error to be thrown');
			} catch (e) {
				assert.instanceOf(e, SymlinkNotAllowedError);
			}
			assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 0);
		}
	});

	test('should detect sophisticated path traversal attempts', async () => {
		const scoped_fs = create_test_instance();

		const tricky_traversal_paths = [
			'/allowed/path/subdir/../../../etc/passwd', // Multiple traversals
			'/allowed/path/./subdir/../../outside', // Mixed ./ and ../
			'/allowed/path/subdir/.././../outside', // Convoluted traversal
			'/allowed/path/foo/../bar/../../../etc/passwd', // Alternating good and bad segments
			'/allowed/path/normal/../normal/../../../out', // Looks somewhat legitimate
		];

		for (const path of tricky_traversal_paths) {
			assert.ok(!scoped_fs.is_path_allowed(path));
			try {
				await scoped_fs.read_file(path);
				assert.fail('Expected error to be thrown');
			} catch (e: any) {
				assert.include(e.message, 'Path is not allowed');
			}
		}
	});

	test('exists should use robust path validation including symlink checks', async () => {
		const scoped_fs = create_test_instance();

		// Setup symlink detection
		vi.mocked(fs.lstat).mockImplementationOnce(() =>
			Promise.resolve({
				isSymbolicLink: () => true,
				isDirectory: () => false,
				isFile: () => false,
			} as any),
		);

		// Should detect symlink and return false without calling access
		const exists = await scoped_fs.exists('/allowed/path/evil-symlink');
		assert.ok(!exists);
		assert.strictEqual(vi.mocked(fs.access).mock.calls.length, 0);
	});
});

describe('ScopedFs - error handling and edge cases', () => {
	test('should handle filesystem errors during path validation gracefully', async () => {
		const scoped_fs = create_test_instance();

		// Setup lstat to throw an unusual error
		vi.mocked(fs.lstat).mockRejectedValue(new Error('Unknown filesystem error'));

		// The error during symlink check should be caught and rethrown
		try {
			await scoped_fs.read_file(FILE_PATHS.ALLOWED);
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'Unknown filesystem error');
		}
		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 0);
	});

	test('should ignore ENOENT errors when checking target path', async () => {
		const scoped_fs = create_test_instance();

		// Setup lstat to throw ENOENT for nonexistent target
		const enoent_error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
		enoent_error.code = 'ENOENT';
		vi.mocked(fs.lstat).mockRejectedValueOnce(enoent_error);

		// Setup successful write (file doesn't exist yet, that's ok)
		vi.mocked(fs.writeFile).mockResolvedValueOnce();

		// Should proceed despite ENOENT - file may not exist yet
		await scoped_fs.write_file(FILE_PATHS.NONEXISTENT, 'new content');
		assert.deepEqual(vi.mocked(fs.writeFile).mock.calls[0], [
			FILE_PATHS.NONEXISTENT,
			'new content',
			'utf8',
		]);
	});

	test('should ignore ENOENT errors when checking parent directories', async () => {
		const scoped_fs = create_test_instance();
		const deep_path = '/allowed/path/new/nested/dirs/file.txt';

		// First call for target path - ENOENT (doesn't exist)
		const enoent_error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
		enoent_error.code = 'ENOENT';

		vi.mocked(fs.lstat).mockImplementation(async (path) => {
			// Root allowed path exists
			if (path === '/allowed/path' || path === '/allowed' || path === '/') {
				return {
					isSymbolicLink: () => false,
					isDirectory: () => true,
					isFile: () => false,
				} as any;
			}
			// Everything else doesn't exist yet
			throw enoent_error;
		});

		// Setup successful write
		vi.mocked(fs.writeFile).mockResolvedValueOnce();

		// Should proceed despite parent directories not existing
		await scoped_fs.write_file(deep_path, 'content');
		assert.deepEqual(vi.mocked(fs.writeFile).mock.calls[0], [deep_path, 'content', 'utf8']);
	});

	test('should NOT ignore non-ENOENT errors when checking paths', async () => {
		const scoped_fs = create_test_instance();

		// Setup lstat to throw EACCES (permission denied)
		const eacces_error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
		eacces_error.code = 'EACCES';
		vi.mocked(fs.lstat).mockRejectedValueOnce(eacces_error);

		// Should throw the EACCES error, not ignore it
		try {
			await scoped_fs.read_file(FILE_PATHS.ALLOWED);
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'EACCES');
		}
		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 0);
	});

	test('should NOT ignore non-ENOENT errors when checking parent directories', async () => {
		const scoped_fs = create_test_instance();
		const nested_path = '/allowed/path/subdir/file.txt';

		// First call succeeds for target
		vi.mocked(fs.lstat).mockResolvedValueOnce({
			isSymbolicLink: () => false,
			isDirectory: () => false,
			isFile: () => true,
		} as any);

		// Second call for parent throws EACCES
		const eacces_error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
		eacces_error.code = 'EACCES';
		vi.mocked(fs.lstat).mockRejectedValueOnce(eacces_error);

		// Should throw the EACCES error from parent check
		try {
			await scoped_fs.read_file(nested_path);
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'EACCES');
		}
		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 0);
	});

	test('should handle a variety of filesystem errors from underlying operations', async () => {
		const scoped_fs = create_test_instance();

		// Reset lstat to normal behavior
		vi.mocked(fs.lstat).mockImplementation(() =>
			Promise.resolve({
				isSymbolicLink: () => false,
				isDirectory: () => false,
				isFile: () => true,
			} as any),
		);

		// Test different fs errors
		const fs_errors = [
			{message: 'ENOENT: no such file or directory', code: 'ENOENT'},
			{message: 'EACCES: permission denied', code: 'EACCES'},
			{message: 'EISDIR: illegal operation on a directory', code: 'EISDIR'},
			{message: 'ENOSPC: no space left on device', code: 'ENOSPC'},
			{message: 'EIO: input/output error', code: 'EIO'},
		];

		for (const {message, code} of fs_errors) {
			const error = new Error(message);
			(error as any).code = code;

			// Reset and configure mock for each error type
			vi.mocked(fs.readFile).mockReset();
			vi.mocked(fs.readFile).mockRejectedValueOnce(error);

			// Error should be passed through
			try {
				await scoped_fs.read_file(FILE_PATHS.ALLOWED);
				assert.fail('Expected error to be thrown');
			} catch (e: any) {
				assert.include(e.message, message);
			}
			assert.deepEqual(vi.mocked(fs.readFile).mock.calls[0], [FILE_PATHS.ALLOWED, 'utf8']);
		}
	});

	test('should handle nonexistent parent directories correctly', async () => {
		const scoped_fs = create_test_instance();
		const deep_nonexistent_path = '/allowed/path/does/not/exist/yet/file.txt';

		// The path itself is allowed since it's under an allowed directory
		assert.ok(scoped_fs.is_path_allowed(deep_nonexistent_path));

		// Write operation should be allowed after path validation
		vi.mocked(fs.writeFile).mockResolvedValueOnce();

		await scoped_fs.write_file(deep_nonexistent_path, 'content');
		assert.deepEqual(vi.mocked(fs.writeFile).mock.calls[0], [
			deep_nonexistent_path,
			'content',
			'utf8',
		]);
	});

	test('should handle extreme edge cases gracefully', async () => {
		const scoped_fs = create_test_instance();

		// Test with various edge case paths
		const edge_case_paths = [
			'/allowed/path/' + 'a'.repeat(255), // Very long filename
			'/allowed/path/' + 'a'.repeat(1000), // Extremely long filename
			'/allowed/path/' + 'a/'.repeat(50) + 'file.txt', // Many nested directories
		];

		for (const path of edge_case_paths) {
			assert.ok(scoped_fs.is_path_allowed(path));

			// Mock a successful read to test the full flow
			vi.mocked(fs.readFile).mockReset();
			vi.mocked(fs.readFile).mockResolvedValueOnce('content' as any);

			const content = await scoped_fs.read_file(path);
			assert.strictEqual(content, 'content');
		}
	});
});

describe('ScopedFs - advanced use cases', () => {
	test('should handle complex workflows with multiple operations', async () => {
		const scoped_fs = create_test_instance();

		// Setup a complex workflow: create dir, write file, read file, copy file, delete original
		vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);
		vi.mocked(fs.writeFile).mockResolvedValueOnce();
		vi.mocked(fs.readFile).mockResolvedValueOnce('file content' as any);
		vi.mocked(fs.copyFile).mockResolvedValueOnce();
		vi.mocked(fs.rm).mockResolvedValueOnce();

		// Execute workflow
		const workflow_dir = '/allowed/path/workflow';
		const source_file = `${workflow_dir}/source.txt`;
		const dest_file = `${workflow_dir}/dest.txt`;

		await scoped_fs.mkdir(workflow_dir);
		await scoped_fs.write_file(source_file, 'original content');
		const content = await scoped_fs.read_file(source_file);
		await scoped_fs.copy_file(source_file, dest_file);
		await scoped_fs.rm(source_file);

		// Verify all operations happened with correct parameters
		assert.strictEqual(content, 'file content');
		assert.deepEqual(vi.mocked(fs.mkdir).mock.calls[0], [workflow_dir, undefined]);
		assert.deepEqual(vi.mocked(fs.writeFile).mock.calls[0], [
			source_file,
			'original content',
			'utf8',
		]);
		assert.deepEqual(vi.mocked(fs.readFile).mock.calls[0], [source_file, 'utf8']);
		assert.deepEqual(vi.mocked(fs.copyFile).mock.calls[0], [source_file, dest_file, undefined]);
		assert.deepEqual(vi.mocked(fs.rm).mock.calls[0], [source_file, undefined]);
	});

	test('should handle concurrent operations correctly', async () => {
		const scoped_fs = create_test_instance();

		// Setup mocks
		vi.mocked(fs.readFile)
			.mockResolvedValueOnce('content1' as any)
			.mockResolvedValueOnce('content2' as any);

		vi.mocked(fs.writeFile).mockResolvedValueOnce().mockResolvedValueOnce();

		// Run concurrent operations
		const [result1, result2] = await Promise.all([
			scoped_fs.read_file('/allowed/path/file1.txt'),
			scoped_fs.read_file('/allowed/path/file2.txt'),
		]);

		await Promise.all([
			scoped_fs.write_file('/allowed/path/output1.txt', 'data1'),
			scoped_fs.write_file('/allowed/path/output2.txt', 'data2'),
		]);

		// Verify results
		assert.strictEqual(result1, 'content1');
		assert.strictEqual(result2, 'content2');
		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 2);
		assert.strictEqual(vi.mocked(fs.writeFile).mock.calls.length, 2);
		// Check that both write calls happened (order may vary with concurrent ops)
		const write_calls = vi.mocked(fs.writeFile).mock.calls;
		const write_paths = write_calls.map((c) => c[0]);
		assert.ok(write_paths.includes('/allowed/path/output1.txt'));
		assert.ok(write_paths.includes('/allowed/path/output2.txt'));
	});

	test('should handle sequential operations that build on each other', async () => {
		const scoped_fs = create_test_instance();

		// Create a more complex scenario with sequential dependent operations
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.writeFile).mockResolvedValue();
		vi.mocked(fs.readdir).mockResolvedValue(['file1.txt', 'file2.txt'] as any);
		// Reset readFile to ensure clean state, then set up expected responses
		vi.mocked(fs.readFile).mockReset();
		vi.mocked(fs.readFile)
			.mockResolvedValueOnce('content1' as any)
			.mockResolvedValueOnce('content2' as any);
		vi.mocked(fs.rm).mockResolvedValue();

		// Execute a complex sequential workflow
		const base_dir = '/allowed/path/project';
		await scoped_fs.mkdir(base_dir);

		// Create some files
		await scoped_fs.write_file(`${base_dir}/file1.txt`, 'content1');
		await scoped_fs.write_file(`${base_dir}/file2.txt`, 'content2');

		// List directory and read each file
		const files = await scoped_fs.readdir(base_dir);
		const contents = [];

		// Read content of each file in directory
		for (const file of files) {
			const file_path = `${base_dir}/${file}`;
			const content = await scoped_fs.read_file(file_path);
			contents.push(content);
		}

		// Clean up
		await scoped_fs.rm(base_dir, {recursive: true});

		// Verify everything worked as expected
		assert.deepEqual(contents, ['content1', 'content2']);
		assert.deepEqual(vi.mocked(fs.mkdir).mock.calls[0], [base_dir, undefined] as any);
		assert.deepEqual(vi.mocked(fs.readdir).mock.calls[0], [base_dir, undefined] as any);
		assert.deepEqual(vi.mocked(fs.rm).mock.calls[0], [base_dir, {recursive: true}] as any);
	});
});

describe('ScopedFs - directory path trailing slash handling', () => {
	test('should ensure all allowed paths have trailing slashes internally', () => {
		// Create instances with a mix of slashed and unslashed paths
		const paths_with_mix = ['/path1', '/path2/', '/path3/subdir', '/path4/subdir/'];
		const scoped_fs = new ScopedFs(paths_with_mix);

		// All paths should have trailing slashes internally
		for (const path of scoped_fs.allowed_paths) {
			assert.ok(path.endsWith('/'));
		}

		// Original array should be unmodified
		assert.deepEqual(paths_with_mix, ['/path1', '/path2/', '/path3/subdir', '/path4/subdir/']);
	});

	test('should correctly validate paths regardless of trailing slashes', () => {
		// Create ScopedFs with paths that don't have trailing slashes
		const scoped_fs = new ScopedFs(['/dir1', '/dir2/subdir']);

		// These paths should all be allowed, with or without trailing slashes
		const valid_paths = [
			'/dir1',
			'/dir1/',
			'/dir1/file.txt',
			'/dir2/subdir',
			'/dir2/subdir/',
			'/dir2/subdir/file.txt',
		];

		for (const path of valid_paths) {
			assert.ok(scoped_fs.is_path_allowed(path));
		}

		// These paths should all be rejected
		const invalid_paths = [
			'/dir', // Parent of allowed path
			'/dir1_extra', // Similar name
			'/dir2', // Parent directory only
			'/dir2/other', // Different subdirectory
		];

		for (const path of invalid_paths) {
			assert.ok(!scoped_fs.is_path_allowed(path));
		}
	});

	test('should handle filesystem operations consistently with or without trailing slashes', async () => {
		// Create ScopedFs with a mix of slashed and unslashed paths
		const scoped_fs = new ScopedFs(['/allowed/path', '/other/dir/']);

		// Mock filesystem operations
		vi.mocked(fs.readFile).mockResolvedValue('content' as any);
		vi.mocked(fs.writeFile).mockResolvedValue();

		// Test path variations
		const test_paths = [
			'/allowed/path',
			'/allowed/path/',
			'/allowed/path/file.txt',
			'/other/dir',
			'/other/dir/',
			'/other/dir/file.txt',
		];

		for (const path of test_paths) {
			vi.mocked(fs.readFile).mockClear();

			// Read operations should work with all variations
			await scoped_fs.read_file(path);
			assert.deepEqual(vi.mocked(fs.readFile).mock.calls[0], [path, 'utf8']);

			// Write operations should also work
			vi.mocked(fs.writeFile).mockClear();
			await scoped_fs.write_file(path, 'content');
			assert.deepEqual(vi.mocked(fs.writeFile).mock.calls[0], [path, 'content', 'utf8']);
		}
	});

	test('should maintain path boundaries correctly with trailing slash normalization', async () => {
		// Create ScopedFs with specific paths
		const scoped_fs = new ScopedFs(['/data/users', '/data/public/']);

		// These paths should be valid
		const valid_paths = [
			'/data/users',
			'/data/users/',
			'/data/users/profile.txt',
			'/data/public',
			'/data/public/',
			'/data/public/index.html',
		];

		// These should be invalid - testing boundary conditions
		const invalid_paths = [
			'/data', // Parent directory
			'/data/user', // Similar but different directory
			'/data/users_archive', // Directory with similar prefix
			'/data/public_html', // Directory with similar prefix
			'/data/users/../private', // Traversal attempt that would normalize outside
		];

		// Test valid paths
		for (const path of valid_paths) {
			assert.ok(scoped_fs.is_path_allowed(path));
		}

		// Test invalid paths
		for (const path of invalid_paths) {
			assert.ok(!scoped_fs.is_path_allowed(path));
			try {
				await scoped_fs.read_file(path);
				assert.fail('Expected error to be thrown');
			} catch (e: any) {
				assert.include(e.message, 'Path is not allowed');
			}
		}
	});

	test('should continue to handle root directory as a special case', async () => {
		// Create ScopedFs with root directory
		const scoped_fs = new ScopedFs(['/']);

		// All paths should be allowed when root is specified
		const test_paths = ['/', '/etc', '/usr/bin', '/home/user/file.txt'];

		for (const path of test_paths) {
			assert.ok(scoped_fs.is_path_allowed(path));

			// Mock successful read
			vi.mocked(fs.readFile).mockReset();
			vi.mocked(fs.readFile).mockResolvedValueOnce('content' as any);

			const content = await scoped_fs.read_file(path);
			assert.strictEqual(content, 'content');
		}
	});
});
