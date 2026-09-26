import { test, describe, assert, vi, afterEach } from 'vitest';

import { normalize_path, prompt_create_diskfile, to_relative_path } from '$lib/diskfile_helpers.ts';
import type { Diskfiles } from '$lib/diskfiles.svelte.ts';

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

describe('prompt_create_diskfile', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const create_diskfiles = (fail?: Error) => {
		const calls: Array<[string, string]> = [];
		const create = (kind: string) => (name: string) => {
			calls.push([kind, name]);
			return fail ? Promise.reject(fail) : Promise.resolve();
		};
		const diskfiles = {
			new_files_dir: '/ws/',
			create_file: create('file'),
			create_directory: create('directory')
		} as unknown as Diskfiles;
		return { diskfiles, calls };
	};

	test('creates a file or folder with the entered name', async () => {
		const prompts: Array<string> = [];
		vi.stubGlobal('prompt', (message: string) => {
			prompts.push(message);
			return 'a.txt';
		});
		const { diskfiles, calls } = create_diskfiles();

		await prompt_create_diskfile(diskfiles, 'file');
		await prompt_create_diskfile(diskfiles, 'folder');

		assert.deepEqual(prompts, ['new file name in /ws/:', 'new folder name in /ws/:']);
		assert.deepEqual(calls, [
			['file', 'a.txt'],
			['directory', 'a.txt']
		]);
	});

	test('does nothing when cancelled or given an empty name', async () => {
		const { diskfiles, calls } = create_diskfiles();
		for (const answer of [null, '']) {
			vi.stubGlobal('prompt', () => answer);
			await prompt_create_diskfile(diskfiles, 'file');
		}
		assert.deepEqual(calls, []);
	});

	test('alerts the error when creating fails', async () => {
		vi.stubGlobal('prompt', () => 'a.txt');
		const alerts: Array<string> = [];
		vi.stubGlobal('alert', (message: string) => alerts.push(message));
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { diskfiles } = create_diskfiles(new Error('already exists'));

		await prompt_create_diskfile(diskfiles, 'folder');

		assert.deepEqual(alerts, ['failed to create folder: already exists']);
	});
});
