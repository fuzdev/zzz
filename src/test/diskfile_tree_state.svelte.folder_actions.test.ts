// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, afterEach, describe, assert, vi } from 'vitest';

import { DiskfilePath } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import {
	to_diskfile_tree_create_key,
	to_diskfile_tree_row_key,
	type DiskfileTreeDirRow
} from '#lib/diskfile_tree_state.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { outline, write_diskfile } from './diskfile_tree_test_helpers.ts';

/**
 * What a folder row's contextmenu drives on `DiskfileTreeState`: expanding and
 * collapsing below a folder, and the inline create.
 */

let app: Frontend;

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = '/w/';
});
afterEach(() => {
	vi.restoreAllMocks();
});

const write = (path: string, source_dir?: string): Diskfile =>
	write_diskfile(app, path, source_dir);

/** Stands in for the backend's `diskfile_create`, which succeeds. */
const stub_diskfile_create = (): void => {
	(app as unknown as { api: unknown }).api = {
		diskfile_create: () => Promise.resolve({ ok: true, value: null })
	};
};

const dir_row = (path: string, root: string = '/w/'): DiskfileTreeDirRow => {
	const key = to_diskfile_tree_row_key(root, path);
	const row = app.diskfiles.editor.tree.rows.find((r) => r.key === key);
	assert.ok(row && (row.kind === 'root' || row.kind === 'dir'), `a folder row for ${path}`);
	return row;
};

describe('expand all below and collapse below', () => {
	test('expand all below opens every folder under the row, and no ignored one', () => {
		app.scoped_dirs = ['/w/a/node_modules/pkg/'];
		write('/w/a/b/c/x.md');
		write('/w/a/d/y.md');
		write('/w/e/z.md');
		write('/w/a/node_modules/pkg/i.js', '/w/a/node_modules/pkg/');
		const { tree } = app.diskfiles.editor;
		tree.collapse_all();
		tree.set_expanded(dir_row('/w/'), true);

		tree.expand_all_below(dir_row('/w/a/'));
		assert.deepEqual(outline(tree.rows), [
			'- /w/',
			'  - a',
			'    - b/c',
			'      x.md',
			'    - d',
			'      y.md',
			'  + e',
			'+ /w/a/node_modules/pkg/'
		]);
		assert.isFalse(tree.expanded.has('/w/a/node_modules/'), 'the ignored folder is left alone');
		assert.isFalse(tree.expanded.has('/w/e/'), 'a sibling is left alone');
	});

	test('expand all below a root expands the root too', () => {
		write('/w/a/x.md');
		const { tree } = app.diskfiles.editor;
		tree.collapse_all();
		tree.expand_all_below(dir_row('/w/'));
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - a', '    x.md']);
	});

	test('collapse below collapses the row and every folder under it, not its siblings', () => {
		write('/w/a/b/x.md');
		write('/w/a/c/y.md');
		write('/w/e/z.md');
		const { tree } = app.diskfiles.editor;
		tree.expand_all_below(dir_row('/w/'));
		tree.collapse_below(dir_row('/w/a/'));
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + a', '  - e', '    z.md']);
		tree.set_expanded(dir_row('/w/a/'), true);
		assert.deepEqual(
			outline(tree.rows),
			['- /w/', '  - a', '    + b', '    + c', '  - e', '    z.md'],
			'expanding it again shows one level'
		);

		tree.collapse_below(dir_row('/w/'));
		assert.deepEqual(outline(tree.rows), ['+ /w/']);
		assert.strictEqual(tree.expanded.size, 0);
	});
});

describe('the inline create', () => {
	test('starts as the first child of its folder, expanded, and made active; cancel ends it', () => {
		write('/w/a/x.md');
		const { tree } = app.diskfiles.editor;
		tree.start_create(dir_row('/w/a/'), 'file');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - a', '    [new file]', '    x.md']);
		assert.strictEqual(tree.active_key, to_diskfile_tree_create_key('/w/', '/w/a/'));
		assert.strictEqual(tree.active_row?.kind, 'create');

		tree.cancel_create();
		assert.isNull(tree.creating);
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - a', '    x.md']);
		assert.strictEqual(tree.active_row?.path, '/w/a/', 'the folder is active again');
	});

	test('in a compact row it creates in the innermost folder', () => {
		write('/w/a/b/x.md');
		const { tree } = app.diskfiles.editor;
		tree.start_create(dir_row('/w/a/b/'), 'folder');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - a/b', '    [new folder]', '    x.md']);
		assert.strictEqual(tree.creating?.dir, '/w/a/b/');
	});

	test('the keyboard does nothing on the input row', () => {
		write('/w/a/x.md');
		const { tree } = app.diskfiles.editor;
		tree.start_create(dir_row('/w/a/'), 'file');
		const before = outline(tree.rows);
		tree.open_active(true);
		tree.expand_active();
		assert.deepEqual(outline(tree.rows), before);
		assert.strictEqual(tree.active_row?.kind, 'create');
	});

	test('commit creates the file inside the folder, a slash creating folders on the way', async () => {
		write('/w/a/x.md');
		const create_file_at = vi
			.spyOn(app.diskfiles, 'create_file_at')
			.mockImplementation(() => Promise.resolve());
		const { tree } = app.diskfiles.editor;

		tree.start_create(dir_row('/w/a/'), 'file');
		tree.creating!.name = ' new.md ';
		assert.isTrue(await tree.commit_create());
		tree.start_create(dir_row('/w/a/'), 'file');
		tree.creating!.name = 'sub/deep.md';
		assert.isTrue(await tree.commit_create());

		assert.deepEqual(
			create_file_at.mock.calls.map((call) => call[0]),
			['/w/a/new.md', '/w/a/sub/deep.md']
		);
		assert.isNull(tree.creating);
	});

	test('an empty name ends it creating nothing', async () => {
		write('/w/a/x.md');
		const create_file_at = vi
			.spyOn(app.diskfiles, 'create_file_at')
			.mockImplementation(() => Promise.resolve());
		const { tree } = app.diskfiles.editor;
		tree.start_create(dir_row('/w/a/'), 'file');
		assert.isFalse(await tree.commit_create());
		assert.isNull(tree.creating);
		assert.deepEqual(create_file_at.mock.calls, []);
	});

	test('a refused name keeps it open with the reason', async () => {
		write('/w/a/x.md');
		const create_file_at = vi
			.spyOn(app.diskfiles, 'create_file_at')
			.mockImplementation(() => Promise.resolve());
		const { tree } = app.diskfiles.editor;
		tree.start_create(dir_row('/w/a/'), 'file');
		const { creating } = tree;
		assert.ok(creating);
		creating.name = 'sub/';
		assert.isFalse(await tree.commit_create());
		assert.strictEqual(tree.creating, creating, 'still open');
		assert.include(creating.error, 'file name must end with a file name');

		creating.name = '../../out.md';
		assert.isFalse(await tree.commit_create());
		assert.include(creating.error, 'must stay inside the directory');
		assert.deepEqual(create_file_at.mock.calls, []);
	});

	test('a failed create keeps it open with the backend’s reason', async () => {
		write('/w/a/x.md');
		vi.spyOn(app.diskfiles, 'create_file_at').mockImplementation(() =>
			Promise.reject(new Error('already exists'))
		);
		const { tree } = app.diskfiles.editor;
		tree.start_create(dir_row('/w/a/'), 'file');
		tree.creating!.name = 'x.md';
		assert.isFalse(await tree.commit_create());
		assert.ok(tree.creating);
		assert.strictEqual(tree.creating.error, 'already exists');
		assert.isFalse(tree.creating.pending);
	});

	test('a new folder, empty, shows anyway: revealed, expanded, and active', async () => {
		write('/w/a/x.md');
		const create_directory_at = vi
			.spyOn(app.diskfiles, 'create_directory_at')
			.mockImplementation(() => Promise.resolve());
		const { tree } = app.diskfiles.editor;
		tree.collapse_all();

		tree.start_create(dir_row('/w/'), 'folder');
		tree.creating!.name = 'p/q';
		assert.isTrue(await tree.commit_create());
		assert.deepEqual(
			create_directory_at.mock.calls.map((call) => call[0]),
			['/w/p/q']
		);
		assert.isTrue(tree.created_dirs.has('/w/p/q/'));
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + a', '  - p/q']);
		assert.strictEqual(tree.active_row?.path, '/w/p/q/');

		// a file arriving in it takes over from the created entry, no duplicate
		write('/w/p/q/f.md');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + a', '  - p/q', '    f.md']);
	});

	test('a created file is revealed when its change arrives', async () => {
		write('/w/a/x.md');
		stub_diskfile_create();
		const { tree } = app.diskfiles.editor;
		tree.collapse_all();

		await app.diskfiles.create_file_at(parse_or_throw(DiskfilePath, '/w/a/b/new.md'));
		assert.isNull(tree.active_key, 'not yet arrived');
		const created = write('/w/a/b/new.md');
		assert.strictEqual(app.diskfiles.selected_file_id, created.id);
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - a', '    - b', '      new.md', '    x.md']);
		assert.strictEqual(tree.active_row?.path, '/w/a/b/new.md');
	});

	test('a slow folder create leaves a newer input where it is', async () => {
		write('/w/a/x.md');
		write('/w/b/y.md');
		let resolve_create = (): void => {};
		vi.spyOn(app.diskfiles, 'create_directory_at').mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolve_create = resolve;
				})
		);
		const { tree } = app.diskfiles.editor;
		tree.start_create(dir_row('/w/a/'), 'folder');
		tree.creating!.name = 'n';
		const committing = tree.commit_create();
		tree.start_create(dir_row('/w/b/'), 'file');
		const newer = tree.creating;
		resolve_create();
		assert.isTrue(await committing);

		assert.strictEqual(tree.creating, newer, 'the newer input stays open');
		assert.strictEqual(tree.active_key, to_diskfile_tree_create_key('/w/', '/w/b/'));
		assert.isTrue(tree.created_dirs.has('/w/a/n/'), 'the folder is still kept');
		assert.isFalse(tree.expanded.has('/w/a/n/'), 'but not revealed');
	});

	test('a created file arriving while a newer input is open isn’t revealed', async () => {
		write('/w/a/x.md');
		write('/w/b/y.md');
		stub_diskfile_create();
		const { tree } = app.diskfiles.editor;
		await app.diskfiles.create_file_at(parse_or_throw(DiskfilePath, '/w/a/new.md'));
		tree.start_create(dir_row('/w/b/'), 'file');
		const created = write('/w/a/new.md');
		assert.strictEqual(app.diskfiles.selected_file_id, created.id, 'still opened');
		assert.strictEqual(tree.active_key, to_diskfile_tree_create_key('/w/', '/w/b/'));
	});

	test('what the index skips is created, with a notice saying why it doesn’t show', async () => {
		write('/w/a/x.md');
		vi.spyOn(app.diskfiles, 'create_file_at').mockImplementation(() => Promise.resolve());
		vi.spyOn(app.diskfiles, 'create_directory_at').mockImplementation(() => Promise.resolve());
		const { tree } = app.diskfiles.editor;
		const cases: Array<[kind: 'file' | 'folder', name: string, notice: string | null]> = [
			[
				'folder',
				'node_modules',
				'created a/node_modules, which the tree doesn’t show: the file index skips "node_modules"'
			],
			[
				'folder',
				'p/.git/q',
				'created a/p/.git/q, which the tree doesn’t show: the file index skips ".git"'
			],
			[
				'file',
				'.zzz-tmp-x',
				'created a/.zzz-tmp-x, which the tree doesn’t show: the file index skips ".zzz-tmp-x"'
			],
			[
				'file',
				'target',
				'created a/target, which the tree doesn’t show: the file index skips "target"'
			],
			['file', 'target.md', null],
			['folder', 'ok', null]
		];
		for (const [kind, name, notice] of cases) {
			tree.start_create(dir_row('/w/a/'), kind);
			assert.isNull(tree.notice, 'a new create clears it');
			tree.creating!.name = name;
			assert.isTrue(await tree.commit_create());
			assert.strictEqual(tree.notice, notice, name);
		}
	});

	test('a file created where the index never looks isn’t waited for', async () => {
		stub_diskfile_create();
		await app.diskfiles.create_file_at(parse_or_throw(DiskfilePath, '/w/node_modules/x.js'));
		// it can still arrive by another root, say one nested inside the ignored folder
		app.scoped_dirs = ['/w/node_modules/'];
		write('/w/node_modules/x.js', '/w/node_modules/');
		assert.isNull(app.diskfiles.selected_file_id, 'not selected later');
	});
});

describe('count_files_below', () => {
	test('every file below a folder, at any depth, from the index’s links', () => {
		write('/w/a/b/c/x.md');
		write('/w/a/b/y.md');
		write('/w/a/z.md');
		write('/w/q.md');
		const { tree } = app.diskfiles.editor;
		assert.strictEqual(tree.count_files_below('/w/'), 4);
		assert.strictEqual(tree.count_files_below('/w/a/'), 3);
		assert.strictEqual(tree.count_files_below('/w/a/b/'), 2);
		assert.strictEqual(tree.count_files_below('/w/missing/'), 0);
		app.diskfiles.remove_by_path(parse_or_throw(DiskfilePath, '/w/a/b/y.md'));
		assert.strictEqual(tree.count_files_below('/w/a/'), 2);
	});
});

describe('the keyboard and the input row', () => {
	test('down and up pass over it, and right moves into the folder’s first file', () => {
		write('/w/a/x.md');
		write('/w/b.md');
		const { tree } = app.diskfiles.editor;
		tree.start_create(dir_row('/w/a/'), 'file');
		assert.deepEqual(outline(tree.rows), [
			'- /w/',
			'  - a',
			'    [new file]',
			'    x.md',
			'  b.md'
		]);

		tree.active_key = to_diskfile_tree_row_key('/w/', '/w/a/');
		tree.move(1);
		assert.strictEqual(tree.active_row?.path, '/w/a/x.md', 'down');
		tree.move(-1);
		assert.strictEqual(tree.active_row?.path, '/w/a/', 'up');
		tree.expand_active();
		assert.strictEqual(tree.active_row?.path, '/w/a/x.md', 'right');
	});

	test('right on a folder holding only the input stays on the folder', () => {
		write('/w/b.md');
		const { tree } = app.diskfiles.editor;
		tree.created_dirs.add('/w/a/');
		tree.start_create(dir_row('/w/a/'), 'file');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - a', '    [new file]', '  b.md']);
		tree.active_key = to_diskfile_tree_row_key('/w/', '/w/a/');
		tree.expand_active();
		assert.strictEqual(tree.active_row?.path, '/w/a/', 'not out to b.md');
	});

	test('as the last row, End and Down stop before it', () => {
		const { tree } = app.diskfiles.editor;
		tree.created_dirs.add('/w/z/');
		tree.start_create(dir_row('/w/z/'), 'file');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - z', '    [new file]']);
		tree.move_to(tree.rows.length - 1, -1);
		assert.strictEqual(tree.active_row?.path, '/w/z/', 'End');
		tree.move(1);
		assert.strictEqual(tree.active_row?.path, '/w/z/', 'Down');
		assert.strictEqual(tree.active_row?.kind, 'dir');
	});
});
