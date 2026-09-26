import { test, describe, assert } from 'vitest';

import { normalize_path, to_relative_path } from '$lib/diskfile_helpers.ts';

describe('to_relative_path', () => {
	test('a path inside the parent is relative to it', () => {
		assert.strictEqual(
			to_relative_path('/home/u/.zzz/foo/bar.json', '/home/u/.zzz/'),
			'foo/bar.json'
		);
	});

	test('a parent without a trailing slash works the same', () => {
		assert.strictEqual(
			to_relative_path('/home/u/.zzz/foo/bar.json', '/home/u/.zzz'),
			'foo/bar.json'
		);
	});

	test('a path outside the parent stays absolute', () => {
		assert.strictEqual(to_relative_path('/home/u/dev/a.ts', '/home/u/.zzz/'), '/home/u/dev/a.ts');
		assert.strictEqual(to_relative_path('/etc/hosts', '/home/u/.zzz/'), '/etc/hosts');
	});

	test('a sibling sharing the parent as a name prefix stays absolute', () => {
		assert.strictEqual(
			to_relative_path('/home/u/.zzzz/a.ts', '/home/u/.zzz'),
			'/home/u/.zzzz/a.ts'
		);
		assert.strictEqual(
			to_relative_path('/home/u/.zzz-old/a.ts', '/home/u/.zzz/'),
			'/home/u/.zzz-old/a.ts'
		);
	});

	test('the parent itself stays absolute rather than becoming empty', () => {
		assert.strictEqual(to_relative_path('/home/u/.zzz/', '/home/u/.zzz/'), '/home/u/.zzz/');
		assert.strictEqual(to_relative_path('/home/u/.zzz', '/home/u/.zzz/'), '/home/u/.zzz');
	});

	test('an empty parent leaves the path unchanged', () => {
		assert.strictEqual(to_relative_path('/home/u/a.ts', ''), '/home/u/a.ts');
	});
});

describe('normalize_path', () => {
	// the backend's `ScopedFs` normalization, which the filer reports paths in
	const cases: Array<[string, string]> = [
		['/ws/a.txt', '/ws/a.txt'],
		['/ws/./a.txt', '/ws/a.txt'],
		['/ws/sub/../a.txt', '/ws/a.txt'],
		['/ws//a.txt', '/ws/a.txt'],
		['/ws/a.txt/', '/ws/a.txt'],
		['/ws/sub/./deeper/../../a.txt', '/ws/a.txt'],
		['/ws/../../../a.txt', '/a.txt'],
		['/..', '/'],
		['/', '/'],
		['/ws/..a/b..', '/ws/..a/b..']
	];
	for (const [input, expected] of cases) {
		test(`${input} → ${expected}`, () => {
			assert.strictEqual(normalize_path(input), expected);
		});
	}
});
