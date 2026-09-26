// @vitest-environment jsdom

import { test, describe, assert, beforeEach, afterEach, vi } from 'vitest';

import { Diskfile } from '$lib/diskfile.svelte.ts';
import { DiskfileJson, DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';
import { Frontend } from '$lib/frontend.svelte.ts';

const PATH = DiskfilePath.parse('/w/a.txt');
const SOURCE_DIR = SerializableDisknode.shape.source_dir.parse('/w/');

let app: Frontend;

beforeEach(() => {
	app = new Frontend();
});

afterEach(() => {
	app.dispose();
	vi.restoreAllMocks();
});

describe('Diskfile schema and fields agree', () => {
	test('dependency lists default to empty, never null', () => {
		const diskfile = new Diskfile({ app, json: { path: PATH, source_dir: SOURCE_DIR } });

		assert.deepEqual(diskfile.dependents, []);
		assert.deepEqual(diskfile.dependencies, []);
		assert.strictEqual(diskfile.dependents_count, 0);
		assert.strictEqual(diskfile.dependencies_count, 0);
	});

	test('content defaults to null — not loaded', () => {
		const diskfile = new Diskfile({ app, json: { path: PATH, source_dir: SOURCE_DIR } });

		assert.isNull(diskfile.content);
		assert.isFalse(diskfile.content_loaded);
	});

	test('path and source_dir are required', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		assert.isFalse(DiskfileJson.safeParse({ source_dir: SOURCE_DIR }).success);
		assert.isFalse(DiskfileJson.safeParse({ path: PATH }).success);
		assert.isFalse(DiskfileJson.safeParse({ path: null, source_dir: SOURCE_DIR }).success);
		assert.throws(() => new Diskfile({ app, json: { source_dir: SOURCE_DIR } as any }));
	});

	test('dependency lists accept what the backend sends', () => {
		const disknode: SerializableDisknode = {
			id: PATH,
			source_dir: SOURCE_DIR,
			contents: 'a',
			ctime: 1,
			mtime: 1,
			dependents: [[DiskfilePath.parse('/w/b.ts'), { any: 'shape' }]],
			dependencies: []
		};
		app.diskfiles.upsert(disknode);

		const diskfile = app.diskfiles.get_by_path(PATH);
		assert.ok(diskfile);
		assert.strictEqual(diskfile.dependents_count, 1);
	});
});
