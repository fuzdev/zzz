import { test, describe, assert, vi, afterEach } from 'vitest';

import {
	delete_diskfile,
	normalize_path,
	parse_new_diskfile_name,
	prompt_create_diskfile,
	to_file_directories,
	to_relative_path
} from '$lib/diskfile_helpers.ts';
import type { Diskfiles } from '$lib/diskfiles.svelte.ts';
import { DiskfilePath } from '$lib/diskfile_types.ts';
import type { Diskfile } from '$lib/diskfile.svelte.ts';

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

describe('parse_new_diskfile_name', () => {
	const accepted: Array<[string, 'file' | 'folder', string]> = [
		['a.txt', 'file', 'a.txt'],
		['  a.txt \n', 'file', 'a.txt'],
		['/a.txt', 'file', 'a.txt'],
		['//sub/a.txt', 'file', 'sub/a.txt'],
		['my file.txt', 'file', 'my file.txt'],
		['sub dir/a b.txt', 'file', 'sub dir/a b.txt'],
		['..a/b..', 'file', '..a/b..'],
		['.env', 'file', '.env'],
		['   /b.txt', 'file', 'b.txt'],
		['  /  a.txt', 'file', 'a.txt'],
		[' / / a.txt ', 'file', 'a.txt'],
		// left for the backend to normalize
		['./a.txt', 'file', './a.txt'],
		['sub/../a.txt', 'file', 'sub/../a.txt'],
		['sub//a.txt', 'file', 'sub//a.txt'],
		['src', 'folder', 'src'],
		['src/', 'folder', 'src/'],
		['a/b/..', 'folder', 'a/b/..'],
		['a/.', 'folder', 'a/.'],
		[' src/lib/ ', 'folder', 'src/lib/']
	];
	for (const [name, kind, expected] of accepted) {
		test(`accepts ${JSON.stringify(name)} as a ${kind} → ${JSON.stringify(expected)}`, () => {
			const result = parse_new_diskfile_name(name, kind);
			assert.ok(result.ok);
			assert.strictEqual(result.value, expected);
		});
	}

	const refused: Array<[string, 'file' | 'folder', string]> = [
		['', 'file', 'must not be blank'],
		['   ', 'file', 'must not be blank'],
		['\t\n', 'folder', 'must not be blank'],
		['/', 'file', 'must not be blank'],
		[' / ', 'folder', 'must not be blank'],
		['.', 'folder', 'names the directory itself'],
		['sub/..', 'folder', 'names the directory itself'],
		['a/', 'file', 'not "/"'],
		['sub/ \t', 'file', 'not "/"'],
		['x/.', 'file', 'not "."'],
		['x/y/..', 'file', 'not ".."'],
		['.', 'file', 'not "."'],
		['a/   /b', 'folder', 'whitespace-only segment'],
		['sub/ \t/a.txt', 'file', 'whitespace-only segment'],
		['..', 'folder', 'inside the directory'],
		['../a.txt', 'file', 'inside the directory'],
		['sub/../../a.txt', 'file', 'inside the directory']
	];
	for (const [name, kind, message] of refused) {
		test(`refuses ${JSON.stringify(name)} as a ${kind}`, () => {
			const result = parse_new_diskfile_name(name, kind);
			assert.ok(!result.ok);
			assert.include(result.message, message);
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
		const console_error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { diskfiles } = create_diskfiles(new Error('already exists'));

		await prompt_create_diskfile(diskfiles, 'folder');

		assert.deepEqual(alerts, ["couldn't create folder a.txt: already exists"]);
		assert.strictEqual(console_error.mock.calls.length, 0, 'the action handler logs it');
	});

	test('quotes a blank name in the alert', async () => {
		vi.stubGlobal('prompt', () => '   ');
		const alerts: Array<string> = [];
		vi.stubGlobal('alert', (message: string) => alerts.push(message));
		const { diskfiles } = create_diskfiles(new Error('file name must not be blank'));

		await prompt_create_diskfile(diskfiles, 'file');

		assert.deepEqual(alerts, ['couldn\'t create file "   ": file name must not be blank']);
	});
});

describe('delete_diskfile', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const path = DiskfilePath.parse('/ws/a.txt');
	const diskfile = { path, path_relative: 'ws/a.txt' } as unknown as Diskfile;

	test('deletes the file', async () => {
		const deleted: Array<string> = [];
		const diskfiles = {
			delete: (p: string) => {
				deleted.push(p);
				return Promise.resolve();
			}
		} as unknown as Diskfiles;
		vi.stubGlobal('alert', () => assert.fail('no alert expected'));

		assert.ok(await delete_diskfile(diskfiles, diskfile));
		assert.deepEqual(deleted, [path]);
	});

	test('alerts the error after the path, without logging it again', async () => {
		const alerts: Array<string> = [];
		vi.stubGlobal('alert', (message: string) => alerts.push(message));
		const console_error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const diskfiles = {
			delete: () => Promise.reject(new Error('failed to delete file: Permission denied: /ws/a.txt'))
		} as unknown as Diskfiles;

		assert.ok(!(await delete_diskfile(diskfiles, diskfile)));
		assert.deepEqual(alerts, [
			"couldn't delete ws/a.txt: failed to delete file: Permission denied: /ws/a.txt"
		]);
		assert.strictEqual(console_error.mock.calls.length, 0);
	});
});

describe('to_file_directories', () => {
	test('every folder from a file up to its root, inclusive, innermost first, and none above', () => {
		assert.deepEqual(to_file_directories('/w/a/b/c.md', '/w/'), ['/w/a/b/', '/w/a/', '/w/']);
		assert.deepEqual(to_file_directories('/w/top.md', '/w/'), ['/w/']);
		assert.deepEqual(to_file_directories('/x/y/z.md', '/x/y/'), ['/x/y/']);
	});

	test('a file outside its root contributes nothing', () => {
		assert.deepEqual(to_file_directories('/elsewhere/a.md', '/w/'), []);
	});

	test('the filesystem root as a root ends the walk', () => {
		assert.deepEqual(to_file_directories('/a/b.md', '/'), ['/a/', '/']);
	});
});
