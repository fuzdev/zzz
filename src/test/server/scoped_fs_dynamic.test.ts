import {test, vi, beforeEach, describe, assert} from 'vitest';
import {assert_rejects} from '@fuzdev/fuz_util/testing.js';
import * as fs from 'node:fs/promises';

import {ScopedFs} from '$lib/server/scoped_fs.js';

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

describe('ScopedFs - add_path', () => {
	test('adds a new path and allows access to files within it', () => {
		const scoped_fs = new ScopedFs(['/initial/path']);

		assert.ok(!scoped_fs.is_path_allowed('/new/path/file.txt'));

		const added = scoped_fs.add_path('/new/path');
		assert.ok(added);
		assert.ok(scoped_fs.is_path_allowed('/new/path/file.txt'));
	});

	test('returns false when adding a path that already exists', () => {
		const scoped_fs = new ScopedFs(['/existing/path']);

		const added = scoped_fs.add_path('/existing/path');
		assert.ok(!added);
	});

	test('normalizes paths with trailing slashes', () => {
		const scoped_fs = new ScopedFs([]);

		scoped_fs.add_path('/new/path');
		// Adding with trailing slash should be a no-op since it normalizes
		const added_again = scoped_fs.add_path('/new/path/');
		assert.ok(!added_again);
	});

	test('throws for relative paths', () => {
		const scoped_fs = new ScopedFs([]);

		assert.throws(() => scoped_fs.add_path('relative/path'));
	});

	test('allows file operations after adding path', async () => {
		const scoped_fs = new ScopedFs([]);

		// Before adding, file ops should fail
		const error = await assert_rejects(() => scoped_fs.read_file('/new/path/file.txt'));
		assert.include(error.message, 'Path is not allowed');

		// After adding, file ops should succeed
		scoped_fs.add_path('/new/path');
		vi.mocked(fs.readFile).mockResolvedValueOnce('content' as any);
		const content = await scoped_fs.read_file('/new/path/file.txt');
		assert.strictEqual(content, 'content');
	});

	test('multiple paths can be added incrementally', () => {
		const scoped_fs = new ScopedFs([]);

		scoped_fs.add_path('/path/a');
		scoped_fs.add_path('/path/b');
		scoped_fs.add_path('/path/c');

		assert.ok(scoped_fs.is_path_allowed('/path/a/file.txt'));
		assert.ok(scoped_fs.is_path_allowed('/path/b/file.txt'));
		assert.ok(scoped_fs.is_path_allowed('/path/c/file.txt'));
		assert.ok(!scoped_fs.is_path_allowed('/path/d/file.txt'));
	});
});

describe('ScopedFs - remove_path', () => {
	test('removes a path and denies access to files within it', () => {
		const scoped_fs = new ScopedFs(['/path/a', '/path/b']);

		assert.ok(scoped_fs.is_path_allowed('/path/a/file.txt'));

		const removed = scoped_fs.remove_path('/path/a');
		assert.ok(removed);
		assert.ok(!scoped_fs.is_path_allowed('/path/a/file.txt'));
		// Other paths unaffected
		assert.ok(scoped_fs.is_path_allowed('/path/b/file.txt'));
	});

	test('returns false when removing a path that does not exist', () => {
		const scoped_fs = new ScopedFs(['/existing/path']);

		const removed = scoped_fs.remove_path('/nonexistent/path');
		assert.ok(!removed);
	});

	test('normalizes path before removing', () => {
		const scoped_fs = new ScopedFs(['/some/path/']);

		// Remove without trailing slash should still match
		const removed = scoped_fs.remove_path('/some/path');
		assert.ok(removed);
		assert.ok(!scoped_fs.is_path_allowed('/some/path/file.txt'));
	});

	test('denies file operations after removing path', async () => {
		const scoped_fs = new ScopedFs(['/removable/path']);

		// Before removing, file ops should succeed
		vi.mocked(fs.readFile).mockResolvedValueOnce('content' as any);
		await scoped_fs.read_file('/removable/path/file.txt');

		// After removing, file ops should fail
		scoped_fs.remove_path('/removable/path');
		const error = await assert_rejects(() => scoped_fs.read_file('/removable/path/file.txt'));
		assert.include(error.message, 'Path is not allowed');
	});

	test('throws for relative paths', () => {
		const scoped_fs = new ScopedFs([]);

		assert.throws(() => scoped_fs.remove_path('relative/path'));
	});
});

describe('ScopedFs - has_path', () => {
	test('returns true for paths in the allowed set', () => {
		const scoped_fs = new ScopedFs(['/path/a', '/path/b']);

		assert.ok(scoped_fs.has_path('/path/a'));
		assert.ok(scoped_fs.has_path('/path/b'));
	});

	test('returns false for paths not in the allowed set', () => {
		const scoped_fs = new ScopedFs(['/path/a']);

		assert.ok(!scoped_fs.has_path('/path/b'));
	});

	test('normalizes paths for comparison', () => {
		const scoped_fs = new ScopedFs(['/path/a/']);

		assert.ok(scoped_fs.has_path('/path/a'));
		assert.ok(scoped_fs.has_path('/path/a/'));
	});

	test('returns false for relative paths', () => {
		const scoped_fs = new ScopedFs(['/path/a']);

		assert.ok(!scoped_fs.has_path('relative/path'));
	});

	test('returns false for child paths (not exact root match)', () => {
		const scoped_fs = new ScopedFs(['/path/a']);

		// has_path checks for exact root, not "is allowed"
		assert.ok(!scoped_fs.has_path('/path/a/child'));
	});
});

describe('ScopedFs - add_path security', () => {
	test('path traversal is blocked on dynamically added paths', () => {
		const scoped_fs = new ScopedFs([]);
		scoped_fs.add_path('/allowed/dir');

		// traversal out of the allowed dir
		assert.ok(!scoped_fs.is_path_allowed('/allowed/dir/../../etc/passwd'));
		// normalized form lands outside
		assert.ok(!scoped_fs.is_path_allowed('/allowed/dir/../secret/file'));
	});

	test('symlinks are rejected on dynamically added paths', async () => {
		const scoped_fs = new ScopedFs([]);
		scoped_fs.add_path('/dynamic/path');

		vi.mocked(fs.lstat).mockImplementationOnce(() =>
			Promise.resolve({
				isSymbolicLink: () => true,
				isDirectory: () => false,
				isFile: () => false,
			} as any),
		);

		assert.ok(!(await scoped_fs.is_path_safe('/dynamic/path/symlink')));
	});

	test('prefix-similar paths are independent', () => {
		const scoped_fs = new ScopedFs([]);
		scoped_fs.add_path('/project');

		// /project-other should NOT be allowed — it's a different directory
		assert.ok(!scoped_fs.is_path_allowed('/project-other/file.txt'));
		// /project/file.txt should be allowed
		assert.ok(scoped_fs.is_path_allowed('/project/file.txt'));
	});
});

describe('ScopedFs - remove_path edge cases', () => {
	test('removing all paths leaves nothing accessible', () => {
		const scoped_fs = new ScopedFs(['/path/a', '/path/b']);

		scoped_fs.remove_path('/path/a');
		scoped_fs.remove_path('/path/b');

		assert.strictEqual(scoped_fs.allowed_paths.length, 0);
		assert.ok(!scoped_fs.is_path_allowed('/path/a/file.txt'));
		assert.ok(!scoped_fs.is_path_allowed('/path/b/file.txt'));
		assert.ok(!scoped_fs.is_path_allowed('/any/path'));
	});

	test('removing a path does not affect children of other paths', () => {
		const scoped_fs = new ScopedFs(['/workspace/a', '/workspace/b']);

		scoped_fs.remove_path('/workspace/a');

		// /workspace/b and its children should still work
		assert.ok(scoped_fs.is_path_allowed('/workspace/b/deeply/nested/file.txt'));
	});

	test('re-adding a previously removed path works', () => {
		const scoped_fs = new ScopedFs(['/ephemeral']);

		scoped_fs.remove_path('/ephemeral');
		assert.ok(!scoped_fs.is_path_allowed('/ephemeral/file.txt'));

		const added = scoped_fs.add_path('/ephemeral');
		assert.ok(added);
		assert.ok(scoped_fs.is_path_allowed('/ephemeral/file.txt'));
	});
});

describe('ScopedFs - add_path and remove_path round-trip', () => {
	test('add then remove returns to original state', () => {
		const scoped_fs = new ScopedFs(['/original/path']);

		scoped_fs.add_path('/temporary/path');
		assert.ok(scoped_fs.is_path_allowed('/temporary/path/file.txt'));

		scoped_fs.remove_path('/temporary/path');
		assert.ok(!scoped_fs.is_path_allowed('/temporary/path/file.txt'));

		// Original still works
		assert.ok(scoped_fs.is_path_allowed('/original/path/file.txt'));
	});

	test('allowed_paths getter reflects changes', () => {
		const scoped_fs = new ScopedFs(['/initial']);

		assert.strictEqual(scoped_fs.allowed_paths.length, 1);

		scoped_fs.add_path('/added');
		assert.strictEqual(scoped_fs.allowed_paths.length, 2);

		scoped_fs.remove_path('/initial');
		assert.strictEqual(scoped_fs.allowed_paths.length, 1);
		assert.ok(scoped_fs.allowed_paths[0]!.startsWith('/added'));
	});
});
