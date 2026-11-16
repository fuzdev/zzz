// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, assert } from 'vitest';

import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import { diskfile_picker_sorters } from '#lib/DiskfilePickerDialog.svelte';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

/** Seeds a file per entry, `null` content throughout, and returns the paths sorted by `key`. */
const sort_by = (key: string, files: Array<[name: string, size: number | null]>): Array<string> => {
	app.diskfiles.add_initial(
		files.map(([name, size]) => ({
			id: parse_or_throw(DiskfilePath, `/w/${name}`),
			source_dir: SOURCE_DIR,
			contents: null,
			size,
			ctime: 1,
			mtime: 1
		}))
	);
	const sorter = diskfile_picker_sorters.find((s) => s.key === key);
	assert.ok(sorter, key);
	return app.diskfiles.on_disk
		.slice()
		.sort(sorter.fn)
		.map((d) => d.path.slice('/w/'.length));
};

const FILES: Array<[string, number | null]> = [
	['mid', 2_000],
	['unknown', null],
	['big', 5_000_000],
	['empty', 0],
	['small', 10]
];

test('largest first sorts by the size on disk, unknown sizes last', () => {
	assert.deepEqual(sort_by('size_largest', FILES), ['big', 'mid', 'small', 'empty', 'unknown']);
});

test('smallest first sorts by the size on disk, unknown sizes last', () => {
	assert.deepEqual(sort_by('size_smallest', FILES), ['empty', 'small', 'mid', 'big', 'unknown']);
});
