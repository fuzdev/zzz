// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, afterEach, describe, assert, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import DiskfileView from '#lib/DiskfileView.svelte';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { create_reactive_props } from './reactive_test_helpers.svelte.ts';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');
const PATH_A = parse_or_throw(DiskfilePath, '/w/a.txt');

let app: Frontend;
let disk: FakeDisk;
const cleanups: Array<() => void> = [];

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
});
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	vi.restoreAllMocks();
});

const load = async (contents: string): Promise<Diskfile> => {
	const d = await disk.load(PATH_A, contents);
	await flush_reads();
	flushSync();
	return d;
};

/** A forgotten cell at `PATH_A`, and a new live cell at the same path. */
const replace = async (): Promise<{ stale: Diskfile; live: Diskfile }> => {
	const stale = await load('v1');
	app.diskfiles.remove_by_path(PATH_A); // no draft: forgotten
	assert.isUndefined(app.diskfiles.peek(PATH_A));
	const live = await load('v2');
	assert.notStrictEqual(stale, live);
	return { stale, live };
};

describe('identity by path across a replaced cell', () => {
	test('a stale cell gets its own state, never the state of the live cell at its path', async () => {
		const { stale, live } = await replace();
		const live_state = app.diskfiles.get_editor_state(live);
		live_state.current_content = 'live draft';
		const throwaway = app.diskfiles.get_editor_state(stale);
		assert.notStrictEqual(throwaway, live_state);
		assert.strictEqual(throwaway.diskfile, stale);
		assert.strictEqual(app.diskfiles.find_editor_state(PATH_A), live_state);
		assert.isTrue(live_state.has_unsaved_edits);
	});

	test('a tab selected for a path with no cell attaches to the cell when the path returns', async () => {
		const stale = await load('v1');
		app.diskfiles.remove_by_path(PATH_A);
		app.diskfiles.select(stale.path, true); // e.g. an open context menu over the gone row
		const tab = app.diskfiles.editor.tabs.by_path.get(PATH_A);
		assert.ok(tab);
		assert.isUndefined(tab.diskfile);
		assert.isNull(app.diskfiles.selected_file);
		const live = await load('v2');
		assert.strictEqual(tab.diskfile, live, 'tab attaches to the new cell');
		assert.strictEqual(app.diskfiles.selected_file, live, 'selection attaches too');
	});

	test('DiskfileView remounts when its cell is replaced at the same path', async () => {
		const stale = await load('v1');
		const props = create_reactive_props<{ diskfile: Diskfile }>({ diskfile: stale });
		const target = document.createElement('div');
		document.body.append(target);
		const mounted = mount(FrontendContextHarness, {
			target,
			props: { app, component: DiskfileView, props }
		});
		cleanups.push(() => {
			void unmount(mounted);
			target.remove();
		});
		flushSync();
		const first = target.querySelector('textarea');
		assert.ok(first);
		app.diskfiles.remove_by_path(PATH_A);
		props.diskfile = await load('v2');
		flushSync();
		const second = target.querySelector('textarea');
		assert.ok(second);
		assert.notStrictEqual(second, first, 'a new cell remounts the view');
		assert.strictEqual(second.value, 'v2');
	});
});
