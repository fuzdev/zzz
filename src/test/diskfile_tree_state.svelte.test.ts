// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert, vi } from 'vitest';

import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { to_file_directories } from '#lib/diskfile_helpers.ts';
import {
	DiskfileTreeIndex,
	compare_natural,
	sort_diskfile_tree_children,
	to_diskfile_tree_row_key,
	to_diskfile_tree_rows,
	type DiskfileTreeSource
} from '#lib/diskfile_tree_state.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { outline, write_diskfile } from './diskfile_tree_test_helpers.ts';
import { seed_diskfile } from './diskfile_test_helpers.ts';

describe('compare_natural', () => {
	test('sorts case-insensitively, numbers by value, ties broken for a total order', () => {
		const names = ['b', 'file10', 'A', 'file9', 'a', 'B', 'file1', '_x'];
		assert.deepEqual(names.sort(compare_natural), [
			'_x',
			'A',
			'a',
			'B',
			'b',
			'file1',
			'file9',
			'file10'
		]);
	});
});

describe('sort_diskfile_tree_children', () => {
	test('sorts folders and files by their names, not their paths', () => {
		const sorted = sort_diskfile_tree_children(
			'/w/',
			['/w/src10/', '/w/B/', '/w/src9/'],
			['/w/z.md', '/w/a10.md', '/w/a9.md']
		);
		assert.deepEqual(sorted, {
			dirs: ['/w/B/', '/w/src9/', '/w/src10/'],
			files: ['/w/a9.md', '/w/a10.md', '/w/z.md']
		});
	});
});

describe('DiskfileTreeIndex', () => {
	const add = (index: DiskfileTreeIndex, path: string, root: string = '/w/'): void =>
		index.add_file(path, to_file_directories(path, root));
	const remove = (index: DiskfileTreeIndex, path: string, root: string = '/w/'): void =>
		index.remove_file(path, to_file_directories(path, root));

	test('links each file into its folders, and the last file out takes them away', () => {
		const index = new DiskfileTreeIndex();
		add(index, '/w/a/b/c.md');
		add(index, '/w/a/d.md');
		assert.deepEqual(index.get_children('/w/'), { dirs: ['/w/a/'], files: [] });
		assert.deepEqual(index.get_children('/w/a/'), { dirs: ['/w/a/b/'], files: ['/w/a/d.md'] });
		assert.deepEqual(index.get_children('/w/a/b/'), { dirs: [], files: ['/w/a/b/c.md'] });

		remove(index, '/w/a/b/c.md');
		assert.deepEqual(index.get_children('/w/a/'), { dirs: [], files: ['/w/a/d.md'] });
		assert.deepEqual(index.get_children('/w/a/b/'), { dirs: [], files: [] });

		remove(index, '/w/a/d.md');
		assert.deepEqual(index.get_children('/w/'), { dirs: [], files: [] });
	});

	test('a folder stays while any file passes through it', () => {
		const index = new DiskfileTreeIndex();
		add(index, '/w/a/x.md');
		add(index, '/w/a/b/y.md');
		add(index, '/w/a/b/z.md');
		remove(index, '/w/a/b/y.md');
		assert.deepEqual(index.get_children('/w/a/').dirs, ['/w/a/b/']);
		remove(index, '/w/a/b/z.md');
		assert.deepEqual(index.get_children('/w/a/').dirs, []);
	});

	test('a folder that is one root and another root’s subfolder keeps both', () => {
		const index = new DiskfileTreeIndex();
		add(index, '/w/a/x.md', '/w/a/');
		add(index, '/w/a/y.md', '/w/');
		assert.deepEqual(index.get_children('/w/'), { dirs: ['/w/a/'], files: [] });
		assert.deepEqual(index.get_children('/w/a/').files, ['/w/a/x.md', '/w/a/y.md']);
		remove(index, '/w/a/x.md', '/w/a/');
		assert.deepEqual(index.get_children('/w/'), { dirs: ['/w/a/'], files: [] });
		remove(index, '/w/a/y.md', '/w/');
		assert.deepEqual(index.get_children('/w/'), { dirs: [], files: [] });
	});

	test('the only child folder is the chain compact folders collapse', () => {
		const index = new DiskfileTreeIndex();
		add(index, '/w/a/b/c.md');
		assert.strictEqual(index.get_only_child_dir('/w/'), '/w/a/');
		assert.strictEqual(index.get_only_child_dir('/w/a/'), '/w/a/b/');
		assert.isNull(index.get_only_child_dir('/w/a/b/'), 'holds a file');
		add(index, '/w/a/e.md');
		assert.isNull(index.get_only_child_dir('/w/a/'), 'a file beside the folder');
	});

	test('caches the sorted children until they change, and bumps its version per change', () => {
		const index = new DiskfileTreeIndex();
		add(index, '/w/b.md');
		const version = index.version;
		const first = index.get_children('/w/');
		assert.strictEqual(index.get_children('/w/'), first, 'cached');
		add(index, '/w/a.md');
		assert.strictEqual(index.version, version + 1);
		assert.notStrictEqual(index.get_children('/w/'), first);
		assert.deepEqual(index.get_children('/w/').files, ['/w/a.md', '/w/b.md']);
	});
});

describe('to_diskfile_tree_rows', () => {
	/**
	 * A source over a fixed map of children, recording which folders it was asked to list —
	 * `repos` the registry repos under `/w/`, each whether it's focused.
	 */
	const create_source = (
		children: Record<string, { dirs?: Array<string>; files?: Array<string> }>,
		expanded: ReadonlyArray<string>,
		repos: Record<string, boolean> = {}
	): DiskfileTreeSource & { listed: Array<string> } => {
		const listed: Array<string> = [];
		const get = (dir: string) => ({
			dirs: children[dir]?.dirs ?? [],
			files: children[dir]?.files ?? []
		});
		return {
			listed,
			get_children: (dir) => {
				listed.push(dir);
				return get(dir);
			},
			get_only_child_dir: (dir) => {
				const { dirs, files } = get(dir);
				return files.length === 0 && dirs.length === 1 ? dirs[0]! : null;
			},
			is_expanded: (path) => expanded.includes(path),
			is_ignored_dir: () => false,
			get_repo: (dir) => (dir in repos ? { project_root: '/w/', focused: repos[dir]! } : null)
		};
	};

	const CHILDREN = {
		'/w/': { dirs: ['/w/a/', '/w/src/'], files: ['/w/readme.md'] },
		'/w/a/': { dirs: ['/w/a/b/'] },
		'/w/a/b/': { dirs: ['/w/a/b/c/'] },
		'/w/a/b/c/': { files: ['/w/a/b/c/deep.md'] },
		'/w/src/': { dirs: ['/w/src/lib/'], files: ['/w/src/main.ts'] },
		'/w/src/lib/': { files: ['/w/src/lib/x.ts'] },
		'/s/': { files: ['/s/notes.md'] }
	};

	test('folders before files, a chain of single folders as one row, collapsed folders unwalked', () => {
		const source = create_source(CHILDREN, ['/w/', '/w/a/', '/w/a/b/', '/w/a/b/c/']);
		const rows = to_diskfile_tree_rows(['/w/', '/s/', '/w/'], source);
		assert.deepEqual(outline(rows), [
			'- /w/',
			'  - a/b/c',
			'    deep.md',
			'  + src',
			'  readme.md',
			'+ /s/'
		]);
		assert.deepEqual(source.listed, ['/w/', '/w/a/b/c/'], 'lists only the expanded folders');
	});

	test('a compact row is keyed by its innermost folder and carries its chain', () => {
		const rows = to_diskfile_tree_rows(
			['/w/'],
			create_source(CHILDREN, ['/w/', '/w/a/', '/w/a/b/', '/w/a/b/c/'])
		);
		const compact = rows[1]!;
		assert(compact.kind === 'dir');
		assert.strictEqual(compact.path, '/w/a/b/c/');
		assert.deepEqual(compact.chain, ['/w/a/', '/w/a/b/', '/w/a/b/c/']);
		assert.isTrue(compact.expanded, 'every folder in its chain is');
		assert.strictEqual(compact.key, to_diskfile_tree_row_key('/w/', '/w/a/b/c/'));
		assert.strictEqual(rows[2]!.parent_key, compact.key);
	});

	test('a compact row is collapsed unless every folder in its chain is expanded', () => {
		for (const expanded of [
			['/w/', '/w/a/'],
			['/w/', '/w/a/b/c/'],
			['/w/', '/w/a/', '/w/a/b/']
		]) {
			const rows = to_diskfile_tree_rows(['/w/'], create_source(CHILDREN, expanded));
			assert.deepEqual(outline(rows).slice(0, 2), ['- /w/', '  + a/b/c'], expanded.join(' '));
		}
	});

	test('rows carry their level, their position among siblings, and their parent', () => {
		const rows = to_diskfile_tree_rows(['/w/', '/s/'], create_source(CHILDREN, ['/w/', '/w/src/']));
		const summary = rows.map((row) => [row.label, row.depth, row.posinset, row.setsize]);
		assert.deepEqual(summary, [
			['/w/', 0, 1, 2],
			['a/b/c', 1, 1, 3],
			['src', 1, 2, 3],
			['lib', 2, 1, 2],
			['main.ts', 2, 2, 2],
			['readme.md', 1, 3, 3],
			['/s/', 0, 2, 2]
		]);
		const main = rows.find((row) => row.label === 'main.ts')!;
		assert.strictEqual(main.parent_key, to_diskfile_tree_row_key('/w/', '/w/src/'));
		assert.isNull(rows[0]!.parent_key);
	});

	test('an unfocused repo is a lazy row, and a repo never joins a compact row', () => {
		const children = {
			'/w/': { dirs: ['/w/app/', '/w/refs/', '/w/site/'] },
			'/w/app/': { dirs: ['/w/app/src/'] },
			'/w/app/src/': { files: ['/w/app/src/x.ts'] },
			// an entry nested one folder down, and one holding a kept draft
			'/w/refs/': { dirs: ['/w/refs/keys/'] },
			'/w/site/': { files: ['/w/site/draft.md'] }
		};
		const source = create_source(
			children,
			['/w/', '/w/app/', '/w/app/src/', '/w/refs/', '/w/refs/keys/', '/w/site/'],
			{ '/w/app/': true, '/w/refs/keys/': false, '/w/site/': false }
		);
		const rows = to_diskfile_tree_rows(['/w/'], source);
		assert.deepEqual(outline(rows), [
			'- /w/',
			'  - app',
			'    - src',
			'      x.ts',
			'  - refs',
			'    ~ keys',
			'  ~ site'
		]);
		const site = rows.at(-1)!;
		assert(site.kind === 'unfocused');
		assert.strictEqual(site.project_root, '/w/');
		assert.strictEqual(site.key, to_diskfile_tree_row_key('/w/', '/w/site/'));
		assert.deepEqual([site.posinset, site.setsize], [3, 3]);
		assert.notInclude(source.listed, '/w/site/', 'an unfocused repo is never walked');
	});

	test('overlapping roots show a path under each, with distinct keys', () => {
		const rows = to_diskfile_tree_rows(
			['/w/', '/w/src/'],
			create_source(CHILDREN, ['/w/', '/w/src/'])
		);
		const keys = rows.map((row) => row.key);
		assert.strictEqual(new Set(keys).size, keys.length);
		assert.strictEqual(rows.filter((row) => row.path === '/w/src/main.ts').length, 2);
	});
});

describe('DiskfileTreeState', () => {
	const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

	let app: Frontend;

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		app = monkeypatch_zzz_for_tests(new Frontend());
		app.zzz_dir = '/w/';
	});

	const write = (path: string, source_dir?: string): Diskfile =>
		write_diskfile(app, path, source_dir);

	const delete_on_disk = (path: string): void => {
		app.diskfiles.handle_change({
			change: { type: 'delete', path: parse_or_throw(DiskfilePath, path) },
			disknode: {
				id: parse_or_throw(DiskfilePath, path),
				source_dir: SOURCE_DIR,
				size: null,
				ctime: null,
				mtime: null
			}
		});
	};

	test('one root per indexed root, its files labeled relative to their folders', () => {
		app.scoped_dirs = ['/s/'];
		write('/w/a/x.md');
		write('/s/notes.md', '/s/');
		const { tree } = app.diskfiles.editor;
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + a', '- /s/', '  notes.md']);
	});

	test('a root nested in another also shows as a folder under it, whichever root reported its files', () => {
		app.scoped_dirs = ['/w/src/'];
		write('/w/src/a.ts', '/w/src/');
		const { tree } = app.diskfiles.editor;
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + src', '- /w/src/', '  a.ts']);

		// the outer root's filer reports it last, then the inner one's again
		write('/w/src/a.ts', '/w/');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + src', '- /w/src/', '  a.ts']);
		write('/w/src/a.ts', '/w/src/');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + src', '- /w/src/', '  a.ts']);
	});

	test('a root nested deeper shows under the outer root through its files, compacted', () => {
		app.scoped_dirs = ['/w/a/src/'];
		write('/w/x.md');
		const { tree } = app.diskfiles.editor;
		assert.deepEqual(
			outline(tree.rows),
			['- /w/', '  x.md', '- /w/a/src/'],
			'empty, it shows only as a root — folders come from files'
		);
		write('/w/a/src/y.ts', '/w/a/src/');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + a/src', '  x.md', '- /w/a/src/', '  y.ts']);
		assert.isTrue(tree.reveal('/w/a/'), 'its folders are in the tree');
	});

	test('a root inside a folder the index never enters shows only as its own root', () => {
		// the default dev layout: the app directory inside the open project
		app.zzz_dir = '/h/p/.zzz/';
		app.scoped_dirs = ['/h/p/', '/h/q/'];
		write('/h/p/.zzz/recordings/a.webm', '/h/p/.zzz/');
		write('/h/p/x.md', '/h/p/');
		// and one inside `node_modules`, under a folder holding other files
		app.scoped_dirs = ['/h/p/', '/h/q/', '/h/q/lib/node_modules/pkg/'];
		write('/h/q/lib/node_modules/pkg/index.js', '/h/q/lib/node_modules/pkg/');
		write('/h/q/lib/main.ts', '/h/q/');
		const { tree } = app.diskfiles.editor;
		tree.expanded.add('/h/q/lib/');
		assert.deepEqual(outline(tree.rows), [
			'- /h/p/.zzz/',
			'  + recordings',
			'- /h/p/',
			'  x.md',
			'- /h/q/',
			'  - lib',
			'    main.ts',
			'- /h/q/lib/node_modules/pkg/',
			'  index.js'
		]);
	});

	test('a custom-named app directory inside a root shows only as its own root', () => {
		app.zzz_dir = '/h/p/data/';
		app.scoped_dirs = ['/h/p/'];
		write('/h/p/data/recordings/a.webm', '/h/p/data/');
		write('/h/p/x.md', '/h/p/');
		const { tree } = app.diskfiles.editor;
		assert.deepEqual(outline(tree.rows), ['- /h/p/data/', '  + recordings', '- /h/p/', '  x.md']);
		assert.isTrue(tree.reveal('/h/p/data/recordings/a.webm'));
		assert.strictEqual(tree.active_row?.root, '/h/p/data/');
	});

	test('a staging folder the index never enters doesn’t show', () => {
		app.scoped_dirs = ['/w/.zzz-tmp-x/'];
		write('/w/.zzz-tmp-x/a.md', '/w/.zzz-tmp-x/');
		write('/w/b.md');
		const { tree } = app.diskfiles.editor;
		assert.deepEqual(outline(tree.rows), ['- /w/', '  b.md', '- /w/.zzz-tmp-x/', '  a.md']);
	});

	test('reveal of a path inside an ignored folder changes nothing', () => {
		app.scoped_dirs = ['/h/q/', '/h/q/lib/node_modules/pkg/'];
		write('/h/q/lib/node_modules/pkg/index.js', '/h/q/lib/node_modules/pkg/');
		write('/h/q/lib/main.ts', '/h/q/');
		const { tree } = app.diskfiles.editor;
		assert.isFalse(tree.reveal('/h/q/lib/node_modules/'));
		assert.strictEqual(tree.expanded.size, 0);
		assert.isNull(tree.active_key);
	});

	test('a compact chain stops at a folder the index never enters', () => {
		app.scoped_dirs = ['/h/r/', '/h/r/a/b/node_modules/pkg/'];
		write('/h/r/a/b/node_modules/pkg/index.js', '/h/r/a/b/node_modules/pkg/');
		const { tree } = app.diskfiles.editor;
		// TODO `a/b` holds nothing the outer root's filer reports, so it shouldn't show at all
		assert.deepEqual(outline(tree.rows).slice(0, 3), ['- /w/', '- /h/r/', '  + a/b']);
	});

	test('a nested root closing leaves its files in the outer root', () => {
		app.scoped_dirs = ['/w/src/'];
		write('/w/src/a.ts', '/w/src/');
		const { tree } = app.diskfiles.editor;
		app.scoped_dirs = [];
		assert.ok(seed_diskfile(app, parse_or_throw(DiskfilePath, '/w/src/a.ts')));
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + src']);
	});

	test('a file kept for its draft under a nested root shows under both roots', () => {
		app.scoped_dirs = ['/w/src/'];
		const kept = write('/w/src/a.ts', '/w/src/');
		app.diskfiles.get_editor_state(kept).current_content = 'draft';
		delete_on_disk('/w/src/a.ts');
		assert.isTrue(kept.deleted_on_disk);
		const { tree } = app.diskfiles.editor;
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + src', '- /w/src/', '  a.ts']);
	});

	test('reveal targets the innermost root holding the path, whichever root reported it', () => {
		app.scoped_dirs = ['/w/src/'];
		const { tree } = app.diskfiles.editor;
		for (const source_dir of ['/w/src/', '/w/', '/w/src/']) {
			write('/w/src/a.ts', source_dir);
			tree.active_key = null;
			assert.isTrue(tree.reveal('/w/src/a.ts'));
			assert.strictEqual(tree.active_row?.root, '/w/src/', `reported by ${source_dir}`);
		}
	});

	test('the rows follow files coming and going', () => {
		write('/w/a.md');
		const { tree } = app.diskfiles.editor;
		assert.deepEqual(outline(tree.rows), ['- /w/', '  a.md']);
		write('/w/b/c.md');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + b', '  a.md']);
		delete_on_disk('/w/b/c.md');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  a.md']);
	});

	test('a file deleted on disk but kept for its draft stays in its folder', () => {
		const kept = write('/w/gone/x.md');
		app.diskfiles.get_editor_state(kept).current_content = 'draft';
		delete_on_disk('/w/gone/x.md');
		assert.isTrue(kept.deleted_on_disk);
		const { tree } = app.diskfiles.editor;
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + gone']);
		tree.expanded.add('/w/gone/');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - gone', '    x.md']);

		app.diskfiles.get_editor_state(kept).discard_draft();
		assert.deepEqual(outline(tree.rows), ['- /w/'], 'gone with its draft');
	});

	test('the index agrees with a from-scratch walk through a long mixed sequence', () => {
		const paths = ['/w/a.md', '/w/a/b.md', '/w/a/b/c.md', '/w/a/b/d.md', '/w/e/f.md'];
		const { tree_index } = app.diskfiles.index;
		for (let step = 0; step < 60; step++) {
			const path = paths[(step * 7) % paths.length]!;
			if (step % 3 === 2) {
				delete_on_disk(path);
			} else {
				write(path);
			}
			const expected = new DiskfileTreeIndex();
			for (const record of app.diskfiles.index.values()) {
				expected.add_file(record.id, to_file_directories(record.id, record.source_dir));
			}
			for (const dir of ['/w/', '/w/a/', '/w/a/b/', '/w/e/']) {
				assert.deepEqual(
					tree_index.get_children(dir),
					expected.get_children(dir),
					`${step} ${dir}`
				);
			}
		}
	});

	test('reveal expands the ancestors, makes the row active, and asks to scroll to it', () => {
		write('/w/a/b/c.md');
		write('/w/a/b/d.md');
		write('/w/a/e.md');
		const { tree } = app.diskfiles.editor;
		tree.collapse_all();
		const request = tree.scroll_request;

		assert.isTrue(tree.reveal('/w/a/b/d.md'));
		assert.deepEqual(outline(tree.rows), [
			'- /w/',
			'  - a',
			'    - b',
			'      c.md',
			'      d.md',
			'    e.md'
		]);
		assert.strictEqual(tree.active_row?.path, '/w/a/b/d.md');
		assert.strictEqual(tree.scroll_request, request + 1);
	});

	test('reveal of a folder inside a compact row reveals that row', () => {
		write('/w/a/b/c/x.md');
		const { tree } = app.diskfiles.editor;
		assert.isTrue(tree.reveal('/w/a/b/'));
		assert.strictEqual(tree.active_row?.label, 'a/b/c');
	});

	test('reveal of a path not in the tree changes nothing', () => {
		write('/w/a/x.md');
		const { tree } = app.diskfiles.editor;
		assert.isFalse(tree.reveal('/w/a/missing.md'));
		assert.isFalse(tree.reveal('/elsewhere/x.md'));
		assert.strictEqual(tree.expanded.size, 0);
		assert.isNull(tree.active_key);
	});

	test('collapse all collapses every folder and root, moving a hidden active row to its root', () => {
		write('/w/a/x.md');
		const { tree } = app.diskfiles.editor;
		tree.reveal('/w/a/x.md');
		tree.collapse_all();
		assert.deepEqual(outline(tree.rows), ['+ /w/']);
		assert.strictEqual(tree.active_row?.kind, 'root');
	});

	test('an expanded compact row stays open when its chain splits', () => {
		write('/w/a/b/c/x.md');
		const { tree } = app.diskfiles.editor;
		const compact = tree.rows.find((row) => row.label === 'a/b/c');
		assert.ok(compact && compact.kind === 'dir');
		tree.set_expanded(compact, true);
		tree.active_key = to_diskfile_tree_row_key('/w/', '/w/a/b/c/x.md');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - a/b/c', '    x.md']);

		write('/w/a/b/y.md');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - a/b', '    - c', '      x.md', '    y.md']);
		assert.strictEqual(tree.active_row?.label, 'x.md', 'the active file still shows');
	});

	test('a folder that merges with a collapsed row below it shows collapsed', () => {
		write('/w/x/a/b/f.md');
		write('/w/x/g.md');
		const { tree } = app.diskfiles.editor;
		const x = tree.rows.find((row) => row.label === 'x');
		assert.ok(x && x.kind === 'dir');
		tree.set_expanded(x, true);
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - x', '    + a/b', '    g.md']);

		delete_on_disk('/w/x/g.md'); // `x` now holds only `a`: the compact row `x/a/b`
		assert.deepEqual(
			outline(tree.rows),
			['- /w/', '  + x/a/b'],
			'never shows what the user didn’t open'
		);

		// opened as one, then split again: both rows stay open
		const merged = tree.rows.find((row) => row.label === 'x/a/b');
		assert.ok(merged && merged.kind === 'dir');
		tree.set_expanded(merged, true);
		write('/w/x/g.md');
		assert.deepEqual(outline(tree.rows), ['- /w/', '  - x', '    - a/b', '      f.md', '    g.md']);
	});

	test('a stale deeper entry doesn’t reopen a row the user collapsed', () => {
		write('/w/a/b/x.md');
		write('/w/a/y.md');
		const { tree } = app.diskfiles.editor;
		const find = (label: string) => {
			const row = tree.rows.find((r) => r.label === label);
			assert.ok(row && row.kind === 'dir', label);
			return row;
		};
		tree.set_expanded(find('a'), true);
		tree.set_expanded(find('b'), true);
		tree.set_expanded(find('a'), false); // `/w/a/b/` stays in the set, as in VS Code
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + a']);

		delete_on_disk('/w/a/y.md'); // `a` now holds only `b`: the compact row `a/b`
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + a/b'], 'still collapsed');
	});

	test('a compact row collapsed after a split stays collapsed when it rejoins', () => {
		write('/w/a/b/x.md');
		const { tree } = app.diskfiles.editor;
		const compact = tree.rows.find((row) => row.label === 'a/b');
		assert.ok(compact && compact.kind === 'dir');
		tree.set_expanded(compact, true);
		write('/w/a/y.md'); // split: `a` over `b`
		const a = tree.rows.find((row) => row.label === 'a');
		assert.ok(a && a.kind === 'dir');
		assert.isTrue(a.expanded);
		tree.set_expanded(a, false);
		delete_on_disk('/w/a/y.md'); // rejoined
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + a/b']);
	});

	test('reveal of a folder inside a compact row leaves that row as it was', () => {
		write('/w/a/b/c/x.md');
		const { tree } = app.diskfiles.editor;
		assert.isTrue(tree.reveal('/w/a/b/'));
		assert.deepEqual(outline(tree.rows), ['- /w/', '  + a/b/c']);
		assert.strictEqual(tree.active_row?.label, 'a/b/c');
	});

	test('collapsing a compact row collapses its whole chain', () => {
		write('/w/a/b/c/x.md');
		const { tree } = app.diskfiles.editor;
		const compact = tree.rows.find((row) => row.label === 'a/b/c');
		assert.ok(compact && compact.kind === 'dir');
		tree.set_expanded(compact, true);
		assert.deepEqual([...tree.expanded].sort(), ['/w/a/', '/w/a/b/', '/w/a/b/c/']);
		tree.toggle(tree.rows.find((row) => row.label === 'a/b/c') as typeof compact);
		assert.strictEqual(tree.expanded.size, 0);
	});

	test('a hidden active row acts from the deepest visible row holding it', () => {
		write('/w/a/b/x.md');
		write('/w/a/y.md');
		write('/w/z.md');
		const { tree } = app.diskfiles.editor;
		tree.reveal('/w/a/b/x.md');

		// its folder collapsed by a click elsewhere
		const b = tree.rows.find((row) => row.label === 'b');
		assert.ok(b && b.kind === 'dir');
		tree.set_expanded(b, false);
		assert.strictEqual(tree.active_row?.label, 'b');
		tree.move(1);
		assert.strictEqual(
			tree.active_row?.label,
			'y.md',
			'the next row after its folder, not the top'
		);

		// acting on the fallback row acts from it: right expands it and keeps it active
		tree.reveal('/w/a/b/x.md');
		tree.set_expanded(b, false);
		tree.expand_active();
		assert.isTrue(tree.expanded.has('/w/a/b/'), 'right expands it');
		assert.strictEqual(tree.active_row?.label, 'b', 'not the stale file below it');
		tree.expand_active();
		assert.strictEqual(tree.active_row?.label, 'x.md', 'then moves in');

		// the active file deleted
		tree.reveal('/w/a/b/x.md');
		write('/w/a/b/w.md');
		delete_on_disk('/w/a/b/x.md');
		assert.strictEqual(tree.active_row?.label, 'b');
	});

	test('the keyboard moves: down and up, right into a folder, left out of it', () => {
		write('/w/a/x.md');
		write('/w/b.md');
		const { tree } = app.diskfiles.editor;
		const active = () => tree.active_row?.label;

		tree.move(1);
		assert.strictEqual(active(), '/w/', 'starts at the first row');
		tree.move(1);
		assert.strictEqual(active(), 'a');
		tree.expand_active();
		assert.isTrue(tree.expanded.has('/w/a/'), 'right expands');
		assert.strictEqual(active(), 'a');
		tree.expand_active();
		assert.strictEqual(active(), 'x.md', 'right again moves in');
		tree.collapse_active();
		assert.strictEqual(active(), 'a', 'left from a file moves to its folder');
		tree.collapse_active();
		assert.isFalse(tree.expanded.has('/w/a/'), 'left collapses');
		tree.collapse_active();
		assert.strictEqual(active(), '/w/', 'left again moves to the root');
		tree.move_to(Infinity);
		assert.strictEqual(active(), 'b.md');
		tree.move(5);
		assert.strictEqual(active(), 'b.md', 'clamped');
	});

	test('enter opens the active file for good, space previews it, and both toggle a folder', () => {
		const file = write('/w/x.md');
		write('/w/a/y.md');
		const { tree } = app.diskfiles.editor;
		const { tabs } = app.diskfiles.editor;

		tree.active_key = to_diskfile_tree_row_key('/w/', '/w/x.md');
		tree.open_active(false);
		assert.strictEqual(app.diskfiles.selected_path, file.path);
		assert.isTrue(tabs.by_path.get(file.path)?.is_preview);
		tree.open_active(true);
		assert.isFalse(tabs.by_path.get(file.path)?.is_preview);

		tree.active_key = to_diskfile_tree_row_key('/w/', '/w/a/');
		tree.open_active(true);
		assert.isTrue(tree.expanded.has('/w/a/'));
		tree.open_active(false);
		assert.isFalse(tree.expanded.has('/w/a/'));
	});
});

describe('DiskfileTreeState.move_path', () => {
	test("a renamed file's active row follows it, any other active row stays", () => {
		const app = monkeypatch_zzz_for_tests(new Frontend());
		const tree = app.diskfiles.editor.tree;
		tree.active_key = to_diskfile_tree_row_key('/w/', '/w/a/x.txt');
		tree.move_path('/w/a/x.txt', '/w/a/y.txt');
		assert.strictEqual(tree.active_key, to_diskfile_tree_row_key('/w/', '/w/a/y.txt'));

		tree.move_path('/w/a/other.txt', '/w/a/z.txt');
		assert.strictEqual(tree.active_key, to_diskfile_tree_row_key('/w/', '/w/a/y.txt'));

		tree.active_key = null;
		tree.move_path('/w/a/y.txt', '/w/a/x.txt');
		assert.isNull(tree.active_key);
	});
});
