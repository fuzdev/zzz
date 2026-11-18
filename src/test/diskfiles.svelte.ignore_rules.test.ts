// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, afterEach, describe, assert, vi } from 'vitest';
import { mdz_parse } from '@fuzdev/mdz/mdz.ts';

import { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import type { ProjectJsonInput } from '#lib/project.svelte.ts';
import {
	to_diskfile_tree_row_key,
	type DiskfileTreeDirRow
} from '#lib/diskfile_tree_state.svelte.ts';
import {
	to_markdown_link_title,
	to_markdown_links,
	type MarkdownLinkStatus
} from '#lib/markdown_links.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { outline, write_diskfile } from './diskfile_tree_test_helpers.ts';

/**
 * Each root's ignore rule as the app derives it from the projects' `ignored`
 * (`Projects.ignore_rules`, read by `Diskfiles.to_unindexed` and the link
 * index): git's answer for a focused git root, fixed names for a plain one —
 * through links, the tree, the create notice, and creating a file.
 */

const GIT = parse_or_throw(DiskfileDirectoryPath, '/g/');
const PLAIN = parse_or_throw(DiskfileDirectoryPath, '/p/');

let app: Frontend;

const project = (
	root: DiskfileDirectoryPath,
	kind: 'git_repo' | 'plain_dir',
	ignored: ProjectJsonInput['ignored'] = {}
): ProjectJsonInput => ({ root, name: root, kind, focused: [root], ignored, rev: 1 });

const GIT_IGNORED = {
	[GIT]: { paths: ['out/', 'x.log'], nested: ['vendor/lib/'], resyncs: 0 }
};

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = '/z/';
	app.projects.add(project(GIT, 'git_repo', GIT_IGNORED));
	app.projects.add(project(PLAIN, 'plain_dir'));
});
afterEach(() => {
	vi.restoreAllMocks();
});

const write = (path: string): Diskfile =>
	write_diskfile(app, path, path.startsWith(GIT) ? GIT : PLAIN);

const dir_row = (path: string, root: string): DiskfileTreeDirRow => {
	const key = to_diskfile_tree_row_key(root, path);
	const row = app.diskfiles.editor.tree.rows.find((r) => r.key === key);
	assert.ok(row && (row.kind === 'root' || row.kind === 'dir'), `a folder row for ${path}`);
	return row;
};

/** A link's status in the file at `file_path`, as `MarkdownPreview` derives it. */
class LinkStatus {
	readonly href: string;
	readonly file_path: string;

	readonly status: MarkdownLinkStatus | null = $derived.by(
		() =>
			to_markdown_links(mdz_parse(`[l](${this.href})`), {
				file_path: this.file_path,
				index: app.diskfiles.link_index
			})[0]!.status
	);

	constructor(href: string, file_path: string) {
		this.href = href;
		this.file_path = file_path;
	}
}

const link_status = (href: string, file_path: string): MarkdownLinkStatus | null =>
	new LinkStatus(href, file_path).status;

describe('links', () => {
	test('under git, what git ignores is not indexed and a tracked dist can be broken', () => {
		write('/g/README.md');
		assert.strictEqual(link_status('./out/a.js', '/g/README.md'), 'skipped');
		assert.strictEqual(link_status('./x.log', '/g/README.md'), 'skipped');
		assert.strictEqual(link_status('./dist/a.js', '/g/README.md'), 'broken');
	});

	test('a repo of its own nested in a git root is not indexed, never broken', () => {
		write('/g/README.md');
		assert.strictEqual(link_status('./vendor/lib/README.md', '/g/README.md'), 'skipped');
		assert.strictEqual(link_status('./vendor/lib', '/g/README.md'), 'skipped');
		assert.strictEqual(link_status('./vendor/other.md', '/g/README.md'), 'broken');
		const [link] = to_markdown_links(mdz_parse('[l](./vendor/lib/x.md)'), {
			file_path: '/g/README.md',
			index: app.diskfiles.link_index
		});
		assert.strictEqual(
			to_markdown_link_title(link!),
			'not indexed, in a repo of its own: /g/vendor/lib/x.md'
		);
	});

	test('under fixed names, the names decide', () => {
		write('/p/README.md');
		assert.strictEqual(link_status('./dist/a.js', '/p/README.md'), 'skipped');
		assert.strictEqual(link_status('./out/a.js', '/p/README.md'), 'broken');
	});

	test('a refresh of `ignored` changes a link’s status', () => {
		write('/g/README.md');
		const link = new LinkStatus('./dist/a.js', '/g/README.md');
		assert.strictEqual(link.status, 'broken');
		const held = app.projects.get_by_root(GIT)!;
		held.ignored = { [GIT]: { paths: ['dist/'], nested: [], resyncs: 0 } };
		assert.strictEqual(link.status, 'skipped', 'git ignores it now');
		held.ignored = {};
		assert.strictEqual(link.status, 'skipped', 'fixed names, git fallen back');
		held.ignored = GIT_IGNORED;
		assert.strictEqual(link.status, 'broken');
	});
});

describe('the tree', () => {
	test('a tracked dist shows under git, what git ignores doesn’t, and fixed names hide dist', () => {
		write('/g/dist/a.js');
		write('/g/out/b.js');
		write('/p/dist/a.js');
		write('/p/out/b.js');
		const { tree } = app.diskfiles.editor;
		tree.expand_all_below(dir_row(GIT, GIT));
		tree.expand_all_below(dir_row(PLAIN, PLAIN));
		assert.deepEqual(outline(tree.rows), [
			'- /z/',
			'- /g/',
			'  - dist',
			'    a.js',
			'- /p/',
			'  - out',
			'    b.js'
		]);
		assert.isTrue(tree.reveal('/g/dist/a.js'));
		assert.isFalse(tree.reveal('/g/out/b.js'));
		assert.isFalse(tree.reveal('/p/dist/a.js'));
	});
});

describe('creating', () => {
	test('the notice says why a new file won’t show, under either rule', async () => {
		write('/g/a.md');
		write('/p/a.md');
		vi.spyOn(app.diskfiles, 'create_file_at').mockImplementation(() => Promise.resolve());
		vi.spyOn(app.diskfiles, 'create_directory_at').mockImplementation(() => Promise.resolve());
		const { tree } = app.diskfiles.editor;
		const cases: Array<
			[root: string, kind: 'file' | 'folder', name: string, notice: string | null]
		> = [
			[
				'/g/',
				'file',
				'out/c.js',
				'created out/c.js, which the tree doesn’t show: git ignores "out/"'
			],
			['/g/', 'folder', 'out', 'created out, which the tree doesn’t show: git ignores "out/"'],
			['/g/', 'file', 'x.log', 'created x.log, which the tree doesn’t show: git ignores "x.log"'],
			[
				'/g/',
				'file',
				'.git/c',
				'created .git/c, which the tree doesn’t show: the file index skips ".git"'
			],
			['/g/', 'file', 'dist/c.js', null],
			[
				'/g/',
				'file',
				'vendor/lib/c.js',
				'created vendor/lib/c.js, which the tree doesn’t show: "vendor/lib/" is a repo of its own'
			],
			[
				'/p/',
				'file',
				'dist/c.js',
				'created dist/c.js, which the tree doesn’t show: the file index skips "dist"'
			],
			['/p/', 'file', 'out/c.js', null]
		];
		for (const [root, kind, name, notice] of cases) {
			tree.start_create(dir_row(root, root), kind);
			tree.naming!.name = name;
			assert.isTrue(await tree.commit_naming());
			assert.strictEqual(tree.notice, notice, `${root}${name}`);
		}
	});

	test('a file created where the rule skips it isn’t waited for, one it indexes is', async () => {
		(app as unknown as { api: unknown }).api = {
			diskfile_create: () => Promise.resolve({ ok: true, value: null })
		};
		const cases: Array<[path: string, waited: boolean]> = [
			['/g/out/c.js', false],
			['/g/vendor/lib/c.js', false],
			['/g/dist/c.js', true],
			['/p/dist/c.js', false],
			['/p/out/c.js', true]
		];
		for (const [path, waited] of cases) {
			await app.diskfiles.create_file_at(parse_or_throw(DiskfilePath, path));
			const created = write(path);
			assert.strictEqual(app.diskfiles.selected_path === created.path, waited, path);
		}
	});
});

describe('a registry root', () => {
	test('its loose files are on fixed names, its focused repo on git’s answer', () => {
		const dev = parse_or_throw(DiskfileDirectoryPath, '/d/');
		const repo = parse_or_throw(DiskfileDirectoryPath, '/d/r/');
		app.projects.add({
			root: dev,
			kind: 'registry',
			focused: [repo],
			ignored: { [repo]: { paths: ['out/'], nested: [], resyncs: 0 } },
			rev: 1
		});
		assert.deepEqual(app.diskfiles.to_unindexed('/d/dist'), { by: 'name', path: '/d/dist' });
		assert.isNull(app.diskfiles.to_unindexed('/d/notes.md'));
		assert.isNull(app.diskfiles.to_unindexed('/d/r/dist/x.js'));
		assert.deepEqual(app.diskfiles.to_unindexed('/d/r/out/x.js'), { by: 'git', path: '/d/r/out/' });
	});
});
