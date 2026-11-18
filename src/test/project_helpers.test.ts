import { test, describe, assert } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import {
	format_project_fallback,
	format_project_opened,
	parse_project_path
} from '#lib/project_helpers.ts';
import { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';

const HOME = parse_or_throw(DiskfileDirectoryPath, '/home/me/');

describe('parse_project_path', () => {
	test('passes an absolute directory or file path through as given', () => {
		for (const raw of ['/home/user/project', '/home/user/project/', '/home/user/project/a.ts']) {
			const result = parse_project_path(raw, HOME);
			assert.ok(result.ok, raw);
			assert.strictEqual(result.path, raw);
		}
	});

	test('trims surrounding whitespace', () => {
		const result = parse_project_path('  /home/user/project \n', HOME);
		assert.ok(result.ok);
		assert.strictEqual(result.path, '/home/user/project');
	});

	test('passes a non-canonical path through for the daemon to resolve', () => {
		const result = parse_project_path('/home/user/./project/../project', HOME);
		assert.ok(result.ok);
		assert.strictEqual(result.path, '/home/user/./project/../project');
	});

	test('rejects empty and whitespace-only input', () => {
		for (const raw of ['', '   ']) {
			const result = parse_project_path(raw, HOME);
			assert.ok(!result.ok, `expected ${JSON.stringify(raw)} to be rejected`);
			assert.strictEqual(result.message, 'path is required');
		}
	});

	test('rejects a relative path', () => {
		for (const raw of ['project', './project', '../project', '.']) {
			const result = parse_project_path(raw, HOME);
			assert.ok(!result.ok, `expected ${raw} to be rejected`);
			assert.include(result.message, 'path must be absolute');
			assert.include(result.message, raw);
		}
	});

	test('expands a leading ~ to the daemon home', () => {
		for (const [raw, expected] of [
			['~', '/home/me/'],
			['~/', '/home/me/'],
			['~/dev/zzz', '/home/me/dev/zzz'],
			['  ~/dev/ ', '/home/me/dev/']
		] as const) {
			const result = parse_project_path(raw, HOME);
			assert.ok(result.ok, raw);
			assert.strictEqual<string>(result.path, expected);
		}
	});

	test("refuses another user's ~, and ~ while the home is unknown", () => {
		const other = parse_project_path('~user/dev', HOME);
		assert.ok(!other.ok);
		assert.include(other.message, 'only your own');
		const unknown = parse_project_path('~/dev', null);
		assert.ok(!unknown.ok);
		assert.include(unknown.message, "home isn't known");
	});
});

describe('format_project_fallback', () => {
	const registry_path = parse_or_throw(DiskfilePath, '/dev/repos.toml');

	test('names the registry and why it was passed over', () => {
		assert.strictEqual(
			format_project_fallback({ kind: 'unregistered', registry_path }),
			'/dev/repos.toml lists no cloned repo holding it'
		);
		assert.strictEqual(
			format_project_fallback({
				kind: 'registry_refused',
				registry_path,
				reason: 'registry_untrusted'
			}),
			"/dev/repos.toml isn't trusted: it or a folder above it has another owner or loose permissions"
		);
		assert.strictEqual(
			format_project_fallback({
				kind: 'registry_refused',
				registry_path,
				reason: 'registry_not_confined'
			}),
			'/dev/repos.toml is a link out of its folder, or through another link'
		);
	});

	test('an unknown reason is shown as given', () => {
		assert.strictEqual(
			format_project_fallback({ kind: 'registry_refused', registry_path, reason: 'new_reason' }),
			'/dev/repos.toml was refused (new_reason)'
		);
	});
});

describe('format_project_opened', () => {
	const root = parse_or_throw(DiskfileDirectoryPath, '/dev/zzz/');

	test('names the root only when it differs from the path', () => {
		assert.strictEqual(
			format_project_opened('/dev/zzz', { root, kind: 'git_repo', fallback: null }),
			'Opened /dev/zzz/ — a git checkout.'
		);
		assert.strictEqual(
			format_project_opened('/dev/zzz/src/a.ts', {
				root,
				kind: 'git_repo',
				fallback: {
					kind: 'unregistered',
					registry_path: parse_or_throw(DiskfilePath, '/dev/repos.toml')
				}
			}),
			'Opened /dev/zzz/src/a.ts, rooted at /dev/zzz/ — a git checkout; /dev/repos.toml lists no cloned repo holding it.'
		);
	});
});
