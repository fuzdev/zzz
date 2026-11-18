// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfilePath } from '#lib/diskfile_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { install_fake_disk, seed_diskfile, type FakeDisk } from './diskfile_test_helpers.ts';

const SOURCE_DIR = '/w/';
const A = parse_or_throw(DiskfilePath, '/w/a.md');
const B = parse_or_throw(DiskfilePath, '/w/b.txt');
const C = parse_or_throw(DiskfilePath, '/w/c.txt');
const NONE = parse_or_throw(DiskfilePath, '/w/none.txt');

let app: Frontend;
let disk: FakeDisk;

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
	await disk.load(A, '# a\n\n## heading\n');
	await disk.load(B, 'b');
	await disk.load(C, 'c');
});

afterEach(() => {
	app.dispose();
	vi.restoreAllMocks();
});

const tab_paths = (): Array<string> => app.diskfiles.editor.tabs.ordered_tabs.map((t) => t.path);

describe('the tab intents', () => {
	test('`tab_open` previews by default, and opens for good when `permanent`', () => {
		const { tabs } = app.diskfiles.editor;
		app.intents.tab_open({ path: A });
		assert.strictEqual(tabs.selected_path, A);
		assert.strictEqual(tabs.preview_tab?.path, A);
		// the next preview replaces it
		app.intents.tab_open({ path: B });
		assert.deepEqual(tab_paths(), [B]);
		app.intents.tab_open({ path: C, permanent: true });
		assert.deepEqual(tab_paths(), [C]);
		assert.strictEqual(tabs.preview_tab, undefined);
		assert.strictEqual(app.diskfiles.selected_path, C);
	});

	test("`tab_open` with a fragment hands it to a markdown file's view", () => {
		app.intents.tab_open({ path: A, permanent: true, fragment: 'heading' });
		assert.strictEqual(app.diskfiles.get_editor_state_at(A)?.markdown_pending_fragment, 'heading');
	});

	test('`tab_select` and `tab_pin` find the tab by path', () => {
		const { tabs } = app.diskfiles.editor;
		app.intents.tab_open({ path: A, permanent: true });
		app.intents.tab_open({ path: B });
		assert.deepEqual(app.intents.tab_select({ path: A }), { found: true });
		assert.strictEqual(tabs.selected_path, A);
		// selecting a preview tab keeps it a preview
		assert.deepEqual(app.intents.tab_select({ path: B }), { found: true });
		assert.strictEqual(tabs.preview_tab?.path, B);
		assert.deepEqual(app.intents.tab_pin({ path: B }), { found: true });
		assert.strictEqual(tabs.preview_tab, undefined);
		assert.deepEqual(app.intents.tab_select({ path: NONE }), { found: false });
		assert.deepEqual(app.intents.tab_pin({ path: NONE }), { found: false });
		assert.strictEqual(tabs.selected_path, B);
	});

	test('`tab_close` closes, asks first for a draft, or finds no tab', () => {
		const { editor } = app.diskfiles;
		app.intents.tab_open({ path: A, permanent: true });
		app.intents.tab_open({ path: B, permanent: true });
		assert.deepEqual(app.intents.tab_close({ path: A }), { result: 'closed' });
		assert.deepEqual(tab_paths(), [B]);
		const b = seed_diskfile(app, B);
		assert.ok(b);
		app.diskfiles.get_editor_state(b).current_content = 'mine';
		assert.deepEqual(app.intents.tab_close({ path: B }), { result: 'asking' });
		assert.strictEqual(editor.pending_close_tab?.path, B);
		assert.deepEqual(tab_paths(), [B]);
		assert.deepEqual(app.intents.tab_close({ path: NONE }), { result: 'no_tab' });
	});

	test('`tab_move` moves by path; `tab_reopen_closed` brings back the last closed', () => {
		for (const path of [A, B, C]) app.intents.tab_open({ path, permanent: true });
		// opened after the selected tab each time
		assert.deepEqual(tab_paths(), [A, B, C]);
		assert.deepEqual(app.intents.tab_move({ path: C, before_path: A }), { moved: true });
		assert.deepEqual(tab_paths(), [C, A, B]);
		assert.deepEqual(app.intents.tab_move({ path: C, before_path: null }), { moved: true });
		assert.deepEqual(tab_paths(), [A, B, C]);
		assert.deepEqual(app.intents.tab_move({ path: NONE, before_path: null }), { moved: false });

		app.intents.tab_close({ path: B });
		assert.deepEqual(app.intents.tab_reopen_closed(), { path: B });
		assert.ok(tab_paths().includes(B));
		assert.strictEqual(app.diskfiles.selected_path, B);
		assert.deepEqual(app.intents.tab_reopen_closed(), { path: null });
	});

	test('`tab_back` / `tab_forward` walk the files visited, as navigation', () => {
		app.intents.tab_open({ path: A, permanent: true });
		app.intents.tab_open({ path: B });
		// the preview reused for another file is a step too
		app.intents.tab_open({ path: C });
		assert.deepEqual(app.intents.tab_back(), { path: B });
		assert.deepEqual(app.intents.tab_back(), { path: A });
		assert.deepEqual(app.intents.tab_back(), { path: null });
		assert.deepEqual(app.intents.tab_forward(), { path: B });
		assert.strictEqual(app.diskfiles.selected_path, B);
		assert.deepEqual(
			app.recent_intents.entries
				.filter((e) => e.method.startsWith('tab_back'))
				.map((e) => e.history),
			['navigation', 'navigation', 'navigation']
		);
	});

	test('each lands in the recent intents', () => {
		app.intents.tab_open({ path: A });
		app.intents.tab_pin({ path: A });
		app.intents.tab_close({ path: A });
		assert.deepEqual(
			app.recent_intents.entries.map((entry) => [entry.method, entry.history]),
			[
				['tab_open', 'layout'],
				['tab_pin', 'layout'],
				['tab_close', 'layout']
			]
		);
	});
});
