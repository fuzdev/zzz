import { parse, parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, assert, vi, afterEach } from 'vitest';

import {
	decode_snapshot_files,
	delete_diskfile,
	disknode_to_diskfile_json,
	normalize_path,
	parse_new_diskfile_name,
	prompt_create_diskfile,
	to_diskfile_copy_paths,
	to_file_directories,
	to_innermost_root,
	to_innermost_unindexed_part,
	to_relative_path,
	to_unindexed_part,
	to_unindexed_reason,
	FILE_INDEX_FIXED_NAMES_RULE,
	type FileIndexIgnoreRule,
	type FileIndexUnindexedPart
} from '#lib/diskfile_helpers.ts';
import type { Diskfiles } from '#lib/diskfiles.svelte.ts';
import {
	DiskfileDirectoryPath,
	DiskfilePath,
	SerializableDisknode,
	SnapshotFiles
} from '#lib/diskfile_types.ts';

describe('SnapshotFiles', () => {
	test('a file is [rel, size, mtime] or [rel, size, mtime, ctime], whole numbers or null', () => {
		const files = [
			{
				dir: '/w/',
				files: [
					['a.txt', 9, 1_700_000_000_000],
					['b/c.txt', null, null, 1_690_000_000_000],
					// a sparse file past 2^53 bytes: imprecise, never refused
					['huge.img', 2 ** 60, 1_700_000_000_000]
				]
			}
		];
		assert.ok(parse(SnapshotFiles, files).ok);
	});

	test('anything else is refused', () => {
		for (const file of [
			[],
			['a.txt', 9],
			['a.txt', 9, 1, 1, 1],
			['', 9, 1],
			['/a.txt', 9, 1],
			[1, 9, 1],
			['a.txt', 9.5, 1],
			['a.txt', 9, 1.5],
			['a.txt', 9, 1, '1'],
			['a.txt', -1, 1],
			['a.txt', 9, -1],
			['a.txt', 9, 2 ** 53],
			['a.txt', 9, Number.NaN],
			['a.txt', 9, 1, 2 ** 53],
			['a.txt', 9, 1, -1],
			{ rel: 'a.txt', size: 9, mtime: 1 }
		]) {
			assert.ok(!parse(SnapshotFiles, [{ dir: '/w/', files: [file] }]).ok, JSON.stringify(file));
		}
		assert.ok(!parse(SnapshotFiles, [{ dir: '/w/', files: [], extra: 1 }]).ok, 'strict');
		assert.ok(!parse(SnapshotFiles, [{ dir: 'w/', files: [] }]).ok, 'an absolute dir');
	});

	test('a disknode takes any whole size and refuses a time no RFC 3339 string holds', () => {
		const node = { id: '/w/a.txt', source_dir: '/w/', size: 9, ctime: null, mtime: 1 };
		assert.ok(parse(SerializableDisknode, { ...node, size: 2 ** 60 }).ok, 'a huge size');
		assert.ok(parse(SerializableDisknode, { ...node, mtime: 253_402_300_799_999 }).ok);
		for (const bad of [{ size: -1 }, { mtime: 2 ** 53 }, { mtime: -1 }, { ctime: -1 }]) {
			assert.ok(!parse(SerializableDisknode, { ...node, ...bad }).ok, JSON.stringify(bad));
		}
	});

	test('the latest time the backend sends converts to a cell', () => {
		const max = 253_402_300_799_999;
		const json = disknode_to_diskfile_json({
			id: parse_or_throw(DiskfilePath, '/w/a.txt'),
			source_dir: parse_or_throw(DiskfileDirectoryPath, '/w/'),
			size: 1,
			ctime: max,
			mtime: max
		});
		assert.strictEqual(json.created, '9999-12-31T23:59:59.999Z');
	});
});

describe('decode_snapshot_files', () => {
	test("each file joins its group's dir, and takes mtime as ctime where it's left off", () => {
		const groups = parse_or_throw(SnapshotFiles, [
			{ dir: '/w/', files: [['a.txt', 9, 20]] },
			{
				dir: '/w/b/',
				files: [
					['c/d.txt', 1, 30, 10],
					['e.txt', 2, null, null],
					['f.txt', 3, 40, null]
				]
			}
		]);
		assert.deepEqual<Array<unknown>>(decode_snapshot_files(groups), [
			{ id: '/w/a.txt', source_dir: '/w/', size: 9, ctime: 20, mtime: 20 },
			{ id: '/w/b/c/d.txt', source_dir: '/w/b/', size: 1, ctime: 10, mtime: 30 },
			{ id: '/w/b/e.txt', source_dir: '/w/b/', size: 2, ctime: null, mtime: null },
			{ id: '/w/b/f.txt', source_dir: '/w/b/', size: 3, ctime: null, mtime: 40 }
		]);
		assert.deepEqual(decode_snapshot_files([]), []);
	});
});

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

	const path = parse_or_throw(DiskfilePath, '/ws/a.txt');
	const to_relative_path = () => 'ws/a.txt';

	test('deletes the file', async () => {
		const deleted: Array<string> = [];
		const diskfiles = {
			delete: (p: string) => {
				deleted.push(p);
				return Promise.resolve();
			},
			to_relative_path
		} as unknown as Diskfiles;
		vi.stubGlobal('alert', () => assert.fail('no alert expected'));

		assert.ok(await delete_diskfile(diskfiles, path));
		assert.deepEqual(deleted, [path]);
	});

	test('alerts the error after the path, without logging it again', async () => {
		const alerts: Array<string> = [];
		vi.stubGlobal('alert', (message: string) => alerts.push(message));
		const console_error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const diskfiles = {
			delete: () =>
				Promise.reject(new Error('failed to delete file: Permission denied: /ws/a.txt')),
			to_relative_path
		} as unknown as Diskfiles;

		assert.ok(!(await delete_diskfile(diskfiles, path)));
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

describe('to_innermost_root', () => {
	test('the innermost root holding the path, in any order of roots', () => {
		const roots = ['/w/a/src/', '/w/', '/s/'];
		assert.strictEqual(to_innermost_root('/w/a/src/x.ts', roots), '/w/a/src/');
		assert.strictEqual(to_innermost_root('/w/a/x.ts', roots), '/w/');
		assert.strictEqual(to_innermost_root('/w/a/src/', roots), '/w/', 'a root isn’t below itself');
		assert.strictEqual(to_innermost_root('/s/notes.md', roots), '/s/');
		assert.isNull(to_innermost_root('/w/', roots));
		assert.isNull(to_innermost_root('/elsewhere/x.ts', roots));
		assert.isNull(to_innermost_root('/wx/a.md', roots), 'a sibling sharing a prefix isn’t inside');
	});
});

describe('to_diskfile_copy_paths', () => {
	const roots = ['/w/', '/w/a/src/', '/s/'];
	const cases: Array<
		[label: string, path: string, absolute: string, relative: string | null, name: string]
	> = [
		['a file in a root', '/w/README.md', '/w/README.md', 'README.md', 'README.md'],
		['a file in a folder', '/w/a/b.md', '/w/a/b.md', 'a/b.md', 'b.md'],
		['a file in a nested root, from it', '/w/a/src/x.ts', '/w/a/src/x.ts', 'x.ts', 'x.ts'],
		['a folder, without its slash', '/w/a/b/', '/w/a/b', 'a/b', 'b'],
		['a nested root, from the outer', '/w/a/src/', '/w/a/src', 'a/src', 'src'],
		['a root under none', '/w/', '/w', null, 'w'],
		['a path under no root', '/x/y.md', '/x/y.md', null, 'y.md']
	];
	test.each(cases)('%s', (_label, path, absolute, relative, name) => {
		assert.deepEqual(to_diskfile_copy_paths(path, roots), { absolute, relative, name });
	});
});

describe('to_unindexed_part', () => {
	const git = (...paths: Array<string>): FileIndexIgnoreRule => ({
		kind: 'git',
		paths: new Set(paths),
		nested: new Set()
	});

	describe('names ignored under every rule', () => {
		const cases: Array<[label: string, path: string, expected: string]> = [
			['a file in .git', '/w/.git/config', '/w/.git/'],
			['.zzz deep down', '/w/p/.zzz/run/x', '/w/p/.zzz/'],
			['a credential folder', '/w/.ssh/id', '/w/.ssh/'],
			['a staging-named file', '/w/a/.zzz-tmp-x', '/w/a/.zzz-tmp-x'],
			['a staging-named folder', '/w/.zzz-tmp-x/a.md', '/w/.zzz-tmp-x/']
		];
		test.each(cases)('%s', (_label, path, expected) => {
			for (const rule of [FILE_INDEX_FIXED_NAMES_RULE, git()]) {
				assert.deepEqual(to_unindexed_part(path, '/w/', rule), { by: 'name', path: expected });
			}
		});

		test('even where git’s paths don’t say so', () => {
			assert.deepEqual(to_unindexed_part('/w/.git/', '/w/', git('a/')), {
				by: 'name',
				path: '/w/.git/'
			});
		});
	});

	describe('fixed names', () => {
		const cases: Array<[label: string, path: string, expected: string | null]> = [
			['a plain file', '/w/a/b.ts', null],
			['a file in an ignored folder', '/w/node_modules/x.js', '/w/node_modules/'],
			['a folder deep in one', '/w/p/node_modules/q/', '/w/p/node_modules/'],
			['an ignored folder itself', '/w/dist/', '/w/dist/'],
			['a file with an ignored name', '/w/target', '/w/target'],
			['a name only containing one', '/w/target.md', null],
			['the first skipped part', '/w/dist/node_modules/x', '/w/dist/'],
			['a path outside the root', '/elsewhere/node_modules/x', null]
		];
		test.each(cases)('%s', (_label, path, expected) => {
			assert.deepEqual(
				to_unindexed_part(path, '/w/', FILE_INDEX_FIXED_NAMES_RULE),
				expected === null ? null : { by: 'name', path: expected }
			);
		});

		test('only what’s below the root counts', () => {
			assert.isNull(
				to_unindexed_part('/w/node_modules/pkg/x.js', '/w/node_modules/pkg/', {
					kind: 'fixed'
				})
			);
		});
	});

	describe('git', () => {
		const rule = git('out/', 'a/b/cache/', 'x.log', 'a/notes.txt');
		const cases: Array<[label: string, path: string, expected: string | null]> = [
			['a file in an ignored folder', '/w/out/x.js', '/w/out/'],
			['the ignored folder itself', '/w/out/', '/w/out/'],
			['deep in a nested ignored folder', '/w/a/b/cache/c/d', '/w/a/b/cache/'],
			['above a nested ignored folder', '/w/a/b/y.ts', null],
			['an ignored file', '/w/x.log', '/w/x.log'],
			['an ignored file in a folder', '/w/a/notes.txt', '/w/a/notes.txt'],
			['a file entry names no folder', '/w/x.log/', null],
			['below a file entry', '/w/x.log/y', null],
			['a folder entry names no file', '/w/out', null],
			['a sibling sharing a prefix', '/w/outer/x', null],
			['fixed names are git’s call', '/w/dist/x.js', null],
			['node_modules too', '/w/node_modules/x.js', null],
			['a path outside the root', '/v/out/x', null]
		];
		test.each(cases)('%s', (_label, path, expected) => {
			assert.deepEqual(
				to_unindexed_part(path, '/w/', rule),
				expected === null ? null : { by: 'git', path: expected }
			);
		});

		test('`./` is the root ignored whole', () => {
			const whole = git('./');
			assert.deepEqual(to_unindexed_part('/w/a/b.ts', '/w/', whole), { by: 'git', path: '/w/' });
			assert.deepEqual(to_unindexed_part('/w/', '/w/', whole), { by: 'git', path: '/w/' });
			assert.isNull(to_unindexed_part('/v/a.ts', '/w/', whole));
		});

		test('a repo of its own is a nested part', () => {
			const with_nested: FileIndexIgnoreRule = {
				kind: 'git',
				paths: new Set(['vendor/lib/out/', 'x/']),
				nested: new Set(['vendor/lib/', 'x/'])
			};
			const nested = (path: string) => to_unindexed_part(path, '/w/', with_nested);
			assert.deepEqual(nested('/w/vendor/lib/a.md'), { by: 'nested', path: '/w/vendor/lib/' });
			assert.deepEqual(nested('/w/vendor/lib/'), { by: 'nested', path: '/w/vendor/lib/' });
			assert.deepEqual(nested('/w/vendor/lib/out/a'), { by: 'nested', path: '/w/vendor/lib/' });
			assert.isNull(nested('/w/vendor/a.md'));
			assert.isNull(nested('/w/vendor/lib'), 'a folder entry names no file');
			assert.isNull(nested('/w/vendor/libs/a.md'));
			// git's answer first, as the walk checks it
			assert.deepEqual(nested('/w/x/a'), { by: 'git', path: '/w/x/' });
			// a fixed rule has none
			assert.isNull(to_unindexed_part('/w/vendor/lib/a.md', '/w/', FILE_INDEX_FIXED_NAMES_RULE));
		});

		test('not relying on the order of `paths`', () => {
			assert.deepEqual(
				to_unindexed_part('/w/z/\u{1F600}/a', '/w/', git('z/\u{1F600}/', 'z/\uFFFF/')),
				{
					by: 'git',
					path: '/w/z/\u{1F600}/'
				}
			);
		});
	});
});

describe('to_innermost_unindexed_part', () => {
	const rules: ReadonlyMap<string, FileIndexIgnoreRule> = new Map([
		['/w/repo/', { kind: 'git', paths: new Set(['build/']), nested: new Set(['sub/']) }]
	]);
	const roots = ['/w/', '/w/repo/', '/w/repo/vendor/'];

	test('a path is skipped only where every filer holding it skips it', () => {
		// `/w/` is on fixed names, `/w/repo/` on git's, which tracks its `dist/`
		assert.isNull(to_innermost_unindexed_part('/w/repo/dist/x.js', roots, [], rules));
		// git ignores `build/`, but `/w/`'s filer indexes it
		assert.isNull(to_innermost_unindexed_part('/w/repo/build/x.js', roots, [], rules));
		assert.isNull(to_innermost_unindexed_part('/w/repo/sub/x.js', roots, [], rules));
		assert.deepEqual(to_innermost_unindexed_part('/w/repo/build/x.js', ['/w/repo/'], [], rules), {
			by: 'git',
			path: '/w/repo/build/'
		});
		assert.deepEqual(to_innermost_unindexed_part('/w/repo/sub/x.js', ['/w/repo/'], [], rules), {
			by: 'nested',
			path: '/w/repo/sub/'
		});
		// fixed names skip `vendor/dist/` under `/w/repo/vendor/`, git's answer doesn't
		assert.isNull(to_innermost_unindexed_part('/w/repo/vendor/dist/x', roots, [], rules));
		assert.deepEqual(to_innermost_unindexed_part('/w/dist/x.js', roots, [], rules), {
			by: 'name',
			path: '/w/dist/'
		});
	});

	test('the part is the innermost skipping root’s', () => {
		// every root holding it skips `.git`, the innermost from its own
		assert.deepEqual(to_innermost_unindexed_part('/w/repo/vendor/.git/x', roots, [], rules), {
			by: 'name',
			path: '/w/repo/vendor/.git/'
		});
		assert.deepEqual(to_innermost_unindexed_part('/w/repo/.git/x', roots, [], rules), {
			by: 'name',
			path: '/w/repo/.git/'
		});
	});

	test('a top-level root holds only its direct children', () => {
		assert.deepEqual(to_innermost_unindexed_part('/w/dist', [], ['/w/'], rules), {
			by: 'name',
			path: '/w/dist'
		});
		assert.deepEqual(to_innermost_unindexed_part('/w/dist/', [], ['/w/'], rules), {
			by: 'name',
			path: '/w/dist/'
		});
		// deeper, no filer holds it
		assert.isNull(to_innermost_unindexed_part('/w/dist/x.js', [], ['/w/'], rules));
		// so a focused repo's rule alone decides below it
		assert.deepEqual(to_innermost_unindexed_part('/w/repo/build/x', ['/w/repo/'], ['/w/'], rules), {
			by: 'git',
			path: '/w/repo/build/'
		});
	});

	test('a root’s own path is judged from the root around it', () => {
		assert.isNull(to_innermost_unindexed_part('/w/repo/', roots, [], rules));
	});

	test('a path under no root', () => {
		assert.isNull(to_innermost_unindexed_part('/v/node_modules/x', roots, [], rules));
	});
});

describe('to_unindexed_reason', () => {
	const cases: Array<[label: string, part: FileIndexUnindexedPart, expected: string]> = [
		[
			'a folder name',
			{ by: 'name', path: '/w/a/node_modules/' },
			'the file index skips "node_modules"'
		],
		['a file name', { by: 'name', path: '/w/a/.zzz-tmp-x' }, 'the file index skips ".zzz-tmp-x"'],
		['a git folder', { by: 'git', path: '/w/a/out/' }, 'git ignores "a/out/"'],
		['a git file', { by: 'git', path: '/w/x.log' }, 'git ignores "x.log"'],
		[
			'a nested repo',
			{ by: 'nested', path: '/w/vendor/lib/' },
			'"vendor/lib/" is a repo of its own'
		]
	];
	test.each(cases)('%s', (_label, part, expected) => {
		assert.strictEqual(to_unindexed_reason(part, '/w/'), expected);
	});
});
