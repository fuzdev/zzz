import { test, describe, assert } from 'vitest';

import { parse_workspace_path } from '$lib/workspace_helpers.ts';

describe('parse_workspace_path', () => {
	test('adds a trailing slash to an absolute path', () => {
		const result = parse_workspace_path('/home/user/project');
		assert.ok(result.ok);
		assert.strictEqual(result.path, '/home/user/project/');
	});

	test('keeps an existing trailing slash', () => {
		const result = parse_workspace_path('/home/user/project/');
		assert.ok(result.ok);
		assert.strictEqual(result.path, '/home/user/project/');
	});

	test('trims surrounding whitespace', () => {
		const result = parse_workspace_path('  /home/user/project \n');
		assert.ok(result.ok);
		assert.strictEqual(result.path, '/home/user/project/');
	});

	test('passes a non-canonical path through for the daemon to canonicalize', () => {
		const result = parse_workspace_path('/home/user/./project/../project');
		assert.ok(result.ok);
		assert.strictEqual(result.path, '/home/user/./project/../project/');
	});

	test('rejects empty and whitespace-only input', () => {
		for (const raw of ['', '   ']) {
			const result = parse_workspace_path(raw);
			assert.ok(!result.ok, `expected ${JSON.stringify(raw)} to be rejected`);
			assert.strictEqual(result.message, 'path is required');
		}
	});

	test('rejects a relative path', () => {
		for (const raw of ['project', './project', '../project', '.']) {
			const result = parse_workspace_path(raw);
			assert.ok(!result.ok, `expected ${raw} to be rejected`);
			assert.include(result.message, 'path must be absolute');
			assert.include(result.message, raw);
		}
	});

	test('rejects a home-relative path instead of guessing the home directory', () => {
		for (const raw of ['~', '~/dev', '~user/dev']) {
			const result = parse_workspace_path(raw);
			assert.ok(!result.ok, `expected ${raw} to be rejected`);
			assert.include(result.message, 'path must be absolute');
			assert.include(result.message, '"~" is not expanded');
		}
	});
});
