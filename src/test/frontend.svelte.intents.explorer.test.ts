// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfilePath } from '#lib/diskfile_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { write_diskfile } from './diskfile_tree_test_helpers.ts';

const SOURCE_DIR = '/w/';
const MD = parse_or_throw(DiskfilePath, '/w/a/b/x.md');
const TXT = parse_or_throw(DiskfilePath, '/w/c.txt');
const NONE = parse_or_throw(DiskfilePath, '/w/none.md');

let app: Frontend;

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = SOURCE_DIR;
	write_diskfile(app, MD);
	write_diskfile(app, TXT);
});

afterEach(() => {
	app.dispose();
	vi.restoreAllMocks();
});

describe('the explorer and markdown intents', () => {
	test('`explorer_mode_set` sets the mode, the same mode twice staying put', () => {
		const { editor } = app.diskfiles;
		assert.strictEqual(editor.explorer_mode, 'list');
		app.intents.explorer_mode_set({ mode: 'tree' });
		assert.strictEqual(editor.explorer_mode, 'tree');
		app.intents.explorer_mode_set({ mode: 'tree' });
		assert.strictEqual(editor.explorer_mode, 'tree');
		app.intents.explorer_mode_set({ mode: 'list' });
		assert.strictEqual(editor.explorer_mode, 'list');
	});

	test('`file_reveal` shows the tree with the file active, its folders expanded', () => {
		const { editor } = app.diskfiles;
		assert.deepEqual(app.intents.file_reveal({ path: MD }), { revealed: true });
		assert.strictEqual(editor.explorer_mode, 'tree');
		assert.strictEqual(editor.tree.active_row?.path, MD);
		assert.isTrue(editor.tree.expanded.has('/w/a/'));
	});

	test('`file_reveal` reveals a folder by its trailing-slash path', () => {
		assert.deepEqual(app.intents.file_reveal({ path: parse_or_throw(DiskfilePath, '/w/a/') }), {
			revealed: true
		});
		assert.strictEqual(app.diskfiles.editor.tree.active_row?.kind, 'dir');
	});

	test('`file_reveal` of a path not in the tree reports it, the tree still shown', () => {
		const { editor } = app.diskfiles;
		assert.deepEqual(app.intents.file_reveal({ path: NONE }), { revealed: false });
		assert.strictEqual(editor.explorer_mode, 'tree');
		assert.isUndefined(editor.tree.active_row);
		const [entry] = app.recent_intents.entries;
		assert.strictEqual(entry?.outcome, 'applied', 'an expected no-op, not a failure');
	});

	test('`markdown_mode_set` keeps the mode by path, with no editing state made', () => {
		assert.deepEqual(app.intents.markdown_mode_set({ path: MD, mode: 'source' }), {
			markdown: true
		});
		assert.isUndefined(app.diskfiles.find_editor_state(MD));
		assert.strictEqual(app.diskfiles.markdown_view_modes.get(MD), 'source');
		assert.strictEqual(app.diskfiles.get_editor_state_at(MD)?.markdown_view_mode, 'source');
	});

	test('`markdown_mode_set` keeps nothing for a file that is not markdown', () => {
		assert.deepEqual(app.intents.markdown_mode_set({ path: TXT, mode: 'preview' }), {
			markdown: false
		});
		assert.strictEqual(app.diskfiles.markdown_view_modes.size, 0);
	});

	test('`markdown_mode_set` refuses a mode that is not one', () => {
		assert.throws(() => app.intents.markdown_mode_set({ path: MD, mode: 'sideways' as never }));
		assert.strictEqual(app.diskfiles.markdown_view_modes.size, 0);
	});
});
