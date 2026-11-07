// @vitest-environment jsdom

import { is, parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, assert, beforeEach, afterEach, vi } from 'vitest';

import { Diskfile } from '#lib/diskfile.svelte.ts';
import { DiskfileJson, DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';

const PATH = parse_or_throw(DiskfilePath, '/w/a.txt');
const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

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
		assert.isFalse(is(DiskfileJson, { source_dir: SOURCE_DIR }));
		assert.isFalse(is(DiskfileJson, { path: PATH }));
		assert.isFalse(is(DiskfileJson, { path: null, source_dir: SOURCE_DIR }));
		assert.throws(() => new Diskfile({ app, json: { source_dir: SOURCE_DIR } as any }));
	});

	test('dependency lists accept what the backend sends', () => {
		const disknode: SerializableDisknode = {
			id: PATH,
			source_dir: SOURCE_DIR,
			contents: 'a',
			ctime: 1,
			mtime: 1,
			dependents: [[parse_or_throw(DiskfilePath, '/w/b.ts'), { any: 'shape' }]],
			dependencies: []
		};
		app.diskfiles.upsert(disknode);

		const diskfile = app.diskfiles.get_by_path(PATH);
		assert.ok(diskfile);
		assert.strictEqual(diskfile.dependents_count, 1);
	});
});
