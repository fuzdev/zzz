// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import DiskfilePickerDialog, {
	create_diskfile_picker_sorters
} from '#lib/DiskfilePickerDialog.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { ResizeObserverStub, write_diskfile } from './diskfile_tree_test_helpers.ts';

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

interface FileSpec {
	name: string;
	size?: number | null;
	ctime?: number | null;
	mtime?: number | null;
}

/** Seeds a file per entry and returns the names sorted by `key`, over the index's records. */
const sort_by = (key: string, files: Array<FileSpec>): Array<string> => {
	app.diskfiles.add_initial(
		files.map(({ name, size = 1, ctime = 1, mtime = 1 }) => ({
			id: parse_or_throw(DiskfilePath, `/w/${name}`),
			source_dir: SOURCE_DIR,
			size,
			ctime,
			mtime
		}))
	);
	const sorter = create_diskfile_picker_sorters(app.diskfiles.index).find((s) => s.key === key);
	assert.ok(sorter, key);
	return app.diskfiles.on_disk
		.slice()
		.sort(sorter.fn)
		.map((record) => record.id.slice('/w/'.length));
};

const SIZES: Array<FileSpec> = [
	{ name: 'mid', size: 2_000 },
	{ name: 'unknown', size: null },
	{ name: 'big', size: 5_000_000 },
	{ name: 'empty', size: 0 },
	{ name: 'small', size: 10 }
];

test('largest first sorts by the size on disk, unknown sizes last', () => {
	assert.deepEqual(sort_by('size_largest', SIZES), ['big', 'mid', 'small', 'empty', 'unknown']);
});

test('smallest first sorts by the size on disk, unknown sizes last', () => {
	assert.deepEqual(sort_by('size_smallest', SIZES), ['empty', 'small', 'mid', 'big', 'unknown']);
});

const TIMES: Array<FileSpec> = [
	{ name: 'b', ctime: 20, mtime: 200 },
	{ name: 'unknown', ctime: null, mtime: null },
	{ name: 'a', ctime: 10, mtime: 300 },
	{ name: 'c', ctime: 30, mtime: 100 }
];

test('the time orders sort by the times on disk, unknown times last in both directions', () => {
	assert.deepEqual(sort_by('created_newest', TIMES), ['c', 'b', 'a', 'unknown']);
	assert.deepEqual(sort_by('created_oldest', TIMES), ['a', 'b', 'c', 'unknown']);
	assert.deepEqual(sort_by('updated_recently', TIMES), ['a', 'b', 'c', 'unknown']);
	assert.deepEqual(sort_by('updated_oldest', TIMES), ['c', 'b', 'a', 'unknown']);
});

test('equal values tie by path, in both directions', () => {
	const files: Array<FileSpec> = [
		{ name: 'z', size: 5 },
		{ name: 'x', size: 5 },
		{ name: 'big', size: 9 },
		{ name: 'y', size: 5 },
		{ name: 'unknown2', size: null },
		{ name: 'unknown1', size: null }
	];
	assert.deepEqual(sort_by('size_largest', files), ['big', 'x', 'y', 'z', 'unknown1', 'unknown2']);
	assert.deepEqual(sort_by('size_smallest', files), ['x', 'y', 'z', 'big', 'unknown1', 'unknown2']);
});

describe('the dialog', () => {
	// jsdom has no modal dialogs
	const dialog_proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
	const originals = { showModal: dialog_proto.showModal, close: dialog_proto.close };
	const cleanups: Array<() => void> = [];
	beforeEach(() => {
		vi.stubGlobal('ResizeObserver', ResizeObserverStub);
		dialog_proto.showModal = function (this: HTMLDialogElement) {
			this.open = true;
		};
		dialog_proto.close = function (this: HTMLDialogElement) {
			this.open = false;
		};
	});
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		dialog_proto.showModal = originals.showModal;
		dialog_proto.close = originals.close;
		vi.unstubAllGlobals();
	});

	test('its rows are options Tab passes over, the filter input keeping the focus', () => {
		write_diskfile(app, '/w/a.md');
		write_diskfile(app, '/w/b.md');
		const target = document.createElement('div');
		document.body.append(target);
		const mounted = mount(FrontendContextHarness, {
			target,
			props: {
				app,
				component: DiskfilePickerDialog,
				props: { show: true, onpick: () => undefined }
			}
		});
		flushSync();
		cleanups.push(() => {
			void unmount(mounted);
			target.remove();
		});
		const rows = Array.from(
			document.querySelectorAll<HTMLElement>('[role="option"] [role="button"]')
		);
		assert.strictEqual(rows.length, 2);
		for (const row of rows) assert.strictEqual(row.tabIndex, -1);
		assert.ok(document.querySelector('input[role="combobox"]'), 'the filter input');
	});
});
