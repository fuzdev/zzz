import {test, vi, beforeEach, afterEach, describe, assert} from 'vitest';
import * as fs from 'node:fs/promises';
import * as fs_sync from 'node:fs';

import {ScopedFs, SymlinkNotAllowedError} from '$lib/server/scoped_fs.js';

// Mock fs/promises and fs modules
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

vi.mock('node:fs', () => ({
	existsSync: vi.fn(),
}));

// Test constants
const TEST_ALLOWED_PATHS = ['/allowed/path', '/allowed/other/path/', '/another/allowed/directory'];
const FILE_PATHS = {
	ALLOWED: '/allowed/path/file.txt',
	NESTED: '/allowed/path/subdir/file.txt',
	OUTSIDE: '/not/allowed/file.txt',
	TRAVERSAL: '/allowed/path/../../../etc/passwd',
};
const DIR_PATHS = {
	ALLOWED: '/allowed/path/dir',
	OUTSIDE: '/not/allowed/dir',
	NEW_DIR: '/allowed/path/new-dir',
};

const create_test_instance = () => new ScopedFs(TEST_ALLOWED_PATHS);

// Setup/cleanup for each test
let console_spy: any;

beforeEach(() => {
	vi.clearAllMocks();
	console_spy = vi.spyOn(console, 'error').mockImplementation(() => {});

	// Default mock implementations
	vi.mocked(fs_sync.existsSync).mockReturnValue(true);

	// Default lstat mock returning a non-symlink file
	vi.mocked(fs.lstat).mockImplementation(() =>
		Promise.resolve({
			isSymbolicLink: () => false,
			isDirectory: () => false,
			isFile: () => true,
		} as any),
	);
});

afterEach(() => {
	console_spy.mockRestore();
});

describe('ScopedFs - construction and initialization', () => {
	test('constructor - should accept an array of allowed paths', () => {
		const scoped_fs = create_test_instance();
		assert.instanceOf(scoped_fs, ScopedFs);
	});

	test('constructor - should make a defensive copy of allowed paths', () => {
		const original_paths = [...TEST_ALLOWED_PATHS];
		const scoped_fs = new ScopedFs(original_paths);

		// Modifying the original array should not affect the instance
		original_paths.push('/new/path');

		// The instance should still only allow the original paths
		assert.ok(!scoped_fs.is_path_allowed('/new/path'));
	});

	test('constructor - should throw for invalid paths', () => {
		// Non-absolute path
		assert.throws(() => new ScopedFs(['relative/path']));

		// Empty path array should work but won't allow any paths
		const empty_scoped_fs = new ScopedFs([]);
		assert.ok(!empty_scoped_fs.is_path_allowed('/any/path'));
	});
});

const path_allowed_cases: Array<[label: string, path: string, expected: boolean]> = [
	// Within allowed directories
	['allowed root /allowed/path', '/allowed/path', true],
	['allowed root /allowed/other/path/', '/allowed/other/path/', true],
	['allowed root /another/allowed/directory', '/another/allowed/directory', true],
	['nested file in allowed path', FILE_PATHS.ALLOWED, true],
	['deep nested file in allowed path', FILE_PATHS.NESTED, true],
	['subdirectory in allowed path', '/allowed/path/subdir/', true],
	// Outside allowed directories
	['file outside allowed paths', FILE_PATHS.OUTSIDE, false],
	['directory outside allowed paths', DIR_PATHS.OUTSIDE, false],
	['parent of allowed path', '/allowed', false],
	['similar prefix but not allowed', '/allowed-other', false],
	// Relative paths
	['relative path (no prefix)', 'relative/path', false],
	['dot-relative path', './relative/path', false],
	['parent-relative path', '../relative/path', false],
	// Path traversal
	['traversal via ../', FILE_PATHS.TRAVERSAL, false],
	['traversal to non-allowed sibling', '/allowed/path/../not-allowed', false],
];

describe('ScopedFs - path validation', () => {
	test.each(path_allowed_cases)('is_path_allowed - %s', (_label, path, expected) => {
		const scoped_fs = create_test_instance();
		assert.strictEqual(scoped_fs.is_path_allowed(path), expected);
	});

	test('is_path_allowed - should handle special cases correctly', () => {
		const scoped_fs = create_test_instance();

		// Empty path
		assert.ok(!scoped_fs.is_path_allowed(''));

		// Root directory (only allowed if explicitly included)
		assert.ok(!scoped_fs.is_path_allowed('/'));

		// With root directory explicitly allowed
		const root_scoped_fs = new ScopedFs(['/']);
		assert.ok(root_scoped_fs.is_path_allowed('/'));
		assert.ok(root_scoped_fs.is_path_allowed('/any/path'));
	});

	test('is_path_safe - should verify path security including symlink checks', async () => {
		const scoped_fs = create_test_instance();

		// Regular allowed path without symlinks
		assert.ok(await scoped_fs.is_path_safe(FILE_PATHS.ALLOWED));

		// Path outside allowed directories
		assert.ok(!(await scoped_fs.is_path_safe(FILE_PATHS.OUTSIDE)));

		// Path with traversal
		assert.ok(!(await scoped_fs.is_path_safe(FILE_PATHS.TRAVERSAL)));

		// Mock a symlink to test rejection
		vi.mocked(fs.lstat).mockImplementationOnce(() =>
			Promise.resolve({
				isSymbolicLink: () => true,
				isDirectory: () => false,
				isFile: () => false,
			} as any),
		);

		// Symlinked file should fail the safety check
		assert.ok(!(await scoped_fs.is_path_safe('/allowed/path/symlink')));
	});
});

describe('ScopedFs - file operations', () => {
	test('read_file - should read files in allowed paths', async () => {
		const scoped_fs = create_test_instance();
		const test_content = 'test file content';

		vi.mocked(fs.readFile).mockResolvedValueOnce(test_content as any);

		const content = await scoped_fs.read_file(FILE_PATHS.ALLOWED);
		assert.strictEqual(content, test_content);
		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 1);
		assert.deepEqual(vi.mocked(fs.readFile).mock.calls[0], [FILE_PATHS.ALLOWED, 'utf8']);
	});

	test('read_file - should return Buffer when options specify buffer encoding', async () => {
		const scoped_fs = create_test_instance();
		const test_buffer = Buffer.from('binary content');

		vi.mocked(fs.readFile).mockResolvedValueOnce(test_buffer);

		const content = await scoped_fs.read_file(FILE_PATHS.ALLOWED, null);
		assert.strictEqual(content, test_buffer);
		assert.deepEqual(vi.mocked(fs.readFile).mock.calls[0], [FILE_PATHS.ALLOWED, null]);
	});

	test('read_file - should pass through various encoding options', async () => {
		const scoped_fs = create_test_instance();

		const encoding_options = [
			{options: 'utf8', expected: 'utf8'},
			{options: 'ascii', expected: 'ascii'},
			{options: {encoding: 'utf8'}, expected: {encoding: 'utf8'}},
			{options: {encoding: null}, expected: {encoding: null}},
		];

		for (const {options, expected} of encoding_options) {
			vi.mocked(fs.readFile).mockReset();
			vi.mocked(fs.readFile).mockResolvedValueOnce('content' as any);

			await scoped_fs.read_file(FILE_PATHS.ALLOWED, options as any);
			assert.deepEqual(vi.mocked(fs.readFile).mock.calls[0], [FILE_PATHS.ALLOWED, expected] as any);
		}
	});

	test('read_file - should throw for paths outside allowed directories', async () => {
		const scoped_fs = create_test_instance();

		try {
			await scoped_fs.read_file(FILE_PATHS.OUTSIDE);
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'Path is not allowed');
		}
		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 0);
	});

	test('write_file - should write to files in allowed paths', async () => {
		const scoped_fs = create_test_instance();
		const test_content = 'test content to write';

		vi.mocked(fs.writeFile).mockResolvedValueOnce();

		await scoped_fs.write_file(FILE_PATHS.ALLOWED, test_content);
		assert.deepEqual(vi.mocked(fs.writeFile).mock.calls[0], [
			FILE_PATHS.ALLOWED,
			test_content,
			'utf8',
		]);
	});

	test('write_file - should throw for paths outside allowed directories', async () => {
		const scoped_fs = create_test_instance();

		try {
			await scoped_fs.write_file(FILE_PATHS.OUTSIDE, 'content');
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'Path is not allowed');
		}
		assert.strictEqual(vi.mocked(fs.writeFile).mock.calls.length, 0);
	});
});

describe('ScopedFs - directory operations', () => {
	test('mkdir - should create directories in allowed paths', async () => {
		const scoped_fs = create_test_instance();

		vi.mocked(fs.mkdir).mockResolvedValueOnce(undefined);

		await scoped_fs.mkdir(DIR_PATHS.NEW_DIR, {recursive: true});
		assert.deepEqual(vi.mocked(fs.mkdir).mock.calls[0], [DIR_PATHS.NEW_DIR, {recursive: true}]);
	});

	test('mkdir - should throw for paths outside allowed directories', async () => {
		const scoped_fs = create_test_instance();

		try {
			await scoped_fs.mkdir(DIR_PATHS.OUTSIDE);
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'Path is not allowed');
		}
		assert.strictEqual(vi.mocked(fs.mkdir).mock.calls.length, 0);
	});

	test('readdir - should list directory contents in allowed paths', async () => {
		const scoped_fs = create_test_instance();
		const dir_contents = ['file1.txt', 'file2.txt', 'subdir'];

		vi.mocked(fs.readdir).mockResolvedValueOnce(dir_contents as any);

		const contents = await scoped_fs.readdir(DIR_PATHS.ALLOWED, null);
		assert.deepEqual(contents, dir_contents);
		assert.deepEqual(vi.mocked(fs.readdir).mock.calls[0], [DIR_PATHS.ALLOWED, null] as any);
	});

	test('readdir - should throw for paths outside allowed directories', async () => {
		const scoped_fs = create_test_instance();

		try {
			await scoped_fs.readdir(DIR_PATHS.OUTSIDE);
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'Path is not allowed');
		}
		assert.strictEqual(vi.mocked(fs.readdir).mock.calls.length, 0);
	});

	test('rm - should remove files or directories in allowed paths', async () => {
		const scoped_fs = create_test_instance();

		vi.mocked(fs.rm).mockResolvedValueOnce();

		await scoped_fs.rm(DIR_PATHS.ALLOWED, {recursive: true});
		assert.deepEqual(vi.mocked(fs.rm).mock.calls[0], [DIR_PATHS.ALLOWED, {recursive: true}]);
	});

	test('rm - should throw for paths outside allowed directories', async () => {
		const scoped_fs = create_test_instance();

		try {
			await scoped_fs.rm(DIR_PATHS.OUTSIDE);
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'Path is not allowed');
		}
		assert.strictEqual(vi.mocked(fs.rm).mock.calls.length, 0);
	});
});

describe('ScopedFs - stat operations', () => {
	test('stat - should get stats for paths in allowed directories', async () => {
		const scoped_fs = create_test_instance();
		const mock_stats = {
			isFile: () => true,
			isDirectory: () => false,
		} as fs_sync.Stats;

		vi.mocked(fs.stat).mockResolvedValueOnce(mock_stats);

		const stats = await scoped_fs.stat(FILE_PATHS.ALLOWED);
		assert.strictEqual(stats, mock_stats);
		assert.deepEqual(vi.mocked(fs.stat).mock.calls[0], [FILE_PATHS.ALLOWED, undefined]);
	});

	test('stat - should throw for paths outside allowed directories', async () => {
		const scoped_fs = create_test_instance();

		try {
			await scoped_fs.stat(FILE_PATHS.OUTSIDE);
			assert.fail('Expected error to be thrown');
		} catch (e: any) {
			assert.include(e.message, 'Path is not allowed');
		}
		assert.strictEqual(vi.mocked(fs.stat).mock.calls.length, 0);
	});

	test('stat - should handle bigint option correctly', async () => {
		const scoped_fs = create_test_instance();

		const stats_tests = [
			{options: undefined, expected_options: undefined},
			{options: {bigint: false}, expected_options: {bigint: false}},
			{options: {bigint: true}, expected_options: {bigint: true}},
		];

		for (const {options, expected_options} of stats_tests) {
			vi.mocked(fs.stat).mockReset();
			vi.mocked(fs.stat).mockResolvedValueOnce({} as any);

			await scoped_fs.stat(FILE_PATHS.ALLOWED, options as any);
			assert.deepEqual(vi.mocked(fs.stat).mock.calls[0], [FILE_PATHS.ALLOWED, expected_options]);
		}
	});

	test('stat - should return BigIntStats when bigint option is true', async () => {
		const scoped_fs = create_test_instance();

		const bigint_stats = {
			size: BigInt(1024),
			mtimeMs: BigInt(Date.now()),
			isFile: () => true,
			isDirectory: () => false,
		} as unknown as fs_sync.BigIntStats;

		vi.mocked(fs.stat).mockResolvedValueOnce(bigint_stats);

		const result = await scoped_fs.stat(FILE_PATHS.ALLOWED, {bigint: true});
		assert.strictEqual(result, bigint_stats as any);
		assert.strictEqual(typeof (result as unknown as fs_sync.BigIntStats).size, 'bigint');
	});
});

describe('ScopedFs - existence checking', () => {
	test('exists - should check existence for paths in allowed directories', async () => {
		const scoped_fs = create_test_instance();

		const existence_tests = [
			{mock_fn: () => vi.mocked(fs.access).mockResolvedValueOnce(), expected: true},
			{
				mock_fn: () => vi.mocked(fs.access).mockRejectedValueOnce(new Error('ENOENT')),
				expected: false,
			},
		];

		for (const {mock_fn, expected} of existence_tests) {
			mock_fn();
			const exists = await scoped_fs.exists(FILE_PATHS.ALLOWED);
			assert.strictEqual(exists, expected);
		}
	});

	test('exists - should return false for paths outside allowed directories', async () => {
		const scoped_fs = create_test_instance();

		const exists = await scoped_fs.exists(FILE_PATHS.OUTSIDE);
		assert.ok(!exists);
		assert.strictEqual(vi.mocked(fs.access).mock.calls.length, 0);
	});
});

describe('ScopedFs - copy operations', () => {
	test('copy_file - should copy files between allowed paths', async () => {
		const scoped_fs = create_test_instance();
		const source = FILE_PATHS.ALLOWED;
		const destination = '/allowed/path/destination.txt';

		vi.mocked(fs.copyFile).mockResolvedValueOnce();

		await scoped_fs.copy_file(source, destination);
		assert.deepEqual(vi.mocked(fs.copyFile).mock.calls[0], [source, destination, undefined]);
	});

	test('copy_file - should pass through mode parameter', async () => {
		const scoped_fs = create_test_instance();
		const source = FILE_PATHS.ALLOWED;
		const destination = '/allowed/path/destination.txt';

		// Test with COPYFILE_EXCL mode (fail if destination exists)
		const COPYFILE_EXCL = 1;
		vi.mocked(fs.copyFile).mockResolvedValueOnce();

		await scoped_fs.copy_file(source, destination, COPYFILE_EXCL);
		assert.deepEqual(vi.mocked(fs.copyFile).mock.calls[0], [source, destination, COPYFILE_EXCL]);

		// Test with COPYFILE_FICLONE mode
		const COPYFILE_FICLONE = 2;
		vi.mocked(fs.copyFile).mockResolvedValueOnce();

		await scoped_fs.copy_file(source, destination, COPYFILE_FICLONE);
		assert.deepEqual(vi.mocked(fs.copyFile).mock.calls[1], [source, destination, COPYFILE_FICLONE]);
	});

	test('copy_file - should throw if either source or destination is outside allowed paths', async () => {
		const scoped_fs = create_test_instance();
		const invalid_copy_operations = [
			{source: FILE_PATHS.OUTSIDE, destination: FILE_PATHS.ALLOWED},
			{source: FILE_PATHS.ALLOWED, destination: FILE_PATHS.OUTSIDE},
		];

		for (const {source, destination} of invalid_copy_operations) {
			try {
				await scoped_fs.copy_file(source, destination);
				assert.fail('Expected error to be thrown');
			} catch (e: any) {
				assert.include(e.message, 'Path is not allowed');
			}
		}

		assert.strictEqual(vi.mocked(fs.copyFile).mock.calls.length, 0);
	});
});

describe('ScopedFs - symlink detection', () => {
	test('should reject operations on paths containing symlinks', async () => {
		const scoped_fs = create_test_instance();

		// Make the file path appear as a symlink
		vi.mocked(fs.lstat).mockImplementationOnce(() =>
			Promise.resolve({
				isSymbolicLink: () => true,
				isDirectory: () => false,
				isFile: () => false,
			} as any),
		);

		try {
			await scoped_fs.read_file('/allowed/path/symlink.txt');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, SymlinkNotAllowedError);
		}

		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 0);
	});

	test('should reject operations when parent directory is a symlink', async () => {
		const scoped_fs = create_test_instance();

		// First check on file itself - not a symlink
		vi.mocked(fs.lstat).mockImplementationOnce(() =>
			Promise.resolve({
				isSymbolicLink: () => false,
				isDirectory: () => false,
				isFile: () => true,
			} as any),
		);

		// Then check on parent - is a symlink
		vi.mocked(fs.lstat).mockImplementationOnce(() =>
			Promise.resolve({
				isSymbolicLink: () => true,
				isDirectory: () => true,
				isFile: () => false,
			} as any),
		);

		try {
			await scoped_fs.read_file('/allowed/path/symlink-dir/file.txt');
			assert.fail('Expected error to be thrown');
		} catch (e) {
			assert.instanceOf(e, SymlinkNotAllowedError);
		}

		assert.strictEqual(vi.mocked(fs.readFile).mock.calls.length, 0);
	});
});
