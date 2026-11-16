// @vitest-environment jsdom

import { parse, parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, afterEach, describe, assert, vi } from 'vitest';
import { create_deferred, type Deferred } from '@fuzdev/fuz_util/async.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import {
	DiskfilePath,
	SerializableDisknode,
	type DiskfileUnloadedReason
} from '#lib/diskfile_types.ts';
import { DISKFILE_READ_CONCURRENCY } from '#lib/diskfiles.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import {
	DISKFILE_CONTENT_LOADING_MESSAGE,
	ERROR_CONTENT_NOT_LOADED,
	to_diskfile_unloaded_message
} from '#lib/diskfile_helpers.ts';
import { HISTORY_LABEL_DISK_CHANGE } from '#lib/diskfile_editor_state.svelte.ts';

import { run_in_effect } from './reactive_test_helpers.svelte.ts';

/**
 * Contents on demand: a diskfile seeded from a disknode (metadata only) is
 * `unrequested` and loads through `diskfile_read` when something needs it
 * (`Diskfiles.ensure_content`); a change on disk re-reads the files held
 * eagerly and drops the rest.
 */

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/ws/');
const to_path = (name: string): DiskfilePath => parse_or_throw(DiskfilePath, `/ws/${name}`);
const PATH_A = to_path('a.txt');
const PATH_B = to_path('b.txt');
const PATH_C = to_path('c.txt');

/** A disknode as the index sends it — metadata only. */
const metadata = (path: DiskfilePath, mtime = 1): SerializableDisknode => ({
	id: path,
	source_dir: SOURCE_DIR,
	size: 1,
	ctime: 1,
	mtime
});

type ReadResult =
	| {
			ok: true;
			value: {
				contents: string | null;
				unloaded_reason: DiskfileUnloadedReason | null;
				size: number;
				ctime: number | null;
				mtime: number | null;
			};
	  }
	| { ok: false; error: { code: number; message: string } };

/** A `diskfile_read` in flight, settled by the test. */
interface PendingRead {
	path: DiskfilePath;
	deferred: Deferred<ReadResult>;
}

let app: Frontend;
let reads: Array<PendingRead>;

beforeEach(() => {
	app = new Frontend();
	reads = [];
	(app as unknown as { api: unknown }).api = {
		diskfile_read: ({ path }: { path: DiskfilePath }) => {
			const deferred = create_deferred<ReadResult>();
			reads.push({ path, deferred });
			return deferred.promise;
		}
	};
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
});

/** Lets queued reads start and landed ones apply. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const read_ok = (contents: string | null, unloaded_reason: DiskfileUnloadedReason | null = null) =>
	({
		ok: true,
		value: { contents, unloaded_reason, size: contents?.length ?? 0, ctime: 1, mtime: 1 }
	}) as const;

const read_error = (message: string) => ({ ok: false, error: { code: -32603, message } }) as const;

/** Settles the oldest unsettled read of `path` and lets it apply. */
const answer = async (path: DiskfilePath, result: ReadResult): Promise<void> => {
	const index = reads.findIndex((read) => read.path === path);
	assert.ok(index !== -1, `a read of ${path} is in flight`);
	const [read] = reads.splice(index, 1);
	read!.deferred.resolve(result);
	await flush();
};

const get = (path: DiskfilePath): Diskfile => {
	const diskfile = app.diskfiles.get_by_path(path);
	assert.ok(diskfile, `a diskfile at ${path}`);
	return diskfile;
};

/** A `filer_change` — metadata only, as every one is. */
const change_on_disk = (path: DiskfilePath, mtime = 2): void => {
	app.diskfiles.handle_change({
		change: { type: 'change', path },
		disknode: metadata(path, mtime)
	});
};

/** A file loaded through a read. */
const load = async (path: DiskfilePath, contents: string): Promise<Diskfile> => {
	app.diskfiles.add_initial([metadata(path)]);
	const diskfile = get(path);
	const loading = app.diskfiles.ensure_content(diskfile);
	await flush();
	await answer(path, read_ok(contents));
	await loading;
	return diskfile;
};

describe('metadata-only seeds', () => {
	test('a file seeded without contents is unrequested, and nothing reads it until asked', async () => {
		app.diskfiles.add_initial([metadata(PATH_A), metadata(PATH_B)]);
		await flush();
		assert.strictEqual(get(PATH_A).content_status, 'unrequested');
		assert.strictEqual(get(PATH_B).content_status, 'unrequested');
		assert.isNull(get(PATH_A).content);
		assert.strictEqual(reads.length, 0);
	});

	test('ensure_content loads it: loading while the read is in flight, then loaded', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const loading = app.diskfiles.ensure_content(diskfile);
		assert.strictEqual(diskfile.content_status, 'loading');
		assert.strictEqual(to_diskfile_unloaded_message(diskfile), DISKFILE_CONTENT_LOADING_MESSAGE);
		await flush();
		assert.deepEqual(
			reads.map((r) => r.path),
			[PATH_A]
		);

		await answer(PATH_A, read_ok('text'));
		await loading;
		assert.strictEqual(diskfile.content_status, 'loaded');
		assert.strictEqual(diskfile.content, 'text');
		assert.isNull(to_diskfile_unloaded_message(diskfile));
	});

	test('a read takes neither size nor mtime — they stay the index metadata', async () => {
		app.diskfiles.add_initial([{ ...metadata(PATH_A, 5), size: 42 }]);
		const diskfile = get(PATH_A);
		const loading = app.diskfiles.ensure_content(diskfile);
		await flush();
		await answer(PATH_A, {
			ok: true,
			value: { contents: 'text', unloaded_reason: null, size: 4, ctime: 9, mtime: 9 }
		});
		await loading;
		assert.strictEqual(diskfile.size, 42);
		assert.strictEqual(diskfile.mtime, 5);
	});

	test('a disknode carries no contents: the schema refuses the key', () => {
		assert.ok(parse(SerializableDisknode, metadata(PATH_A)).ok);
		for (const contents of ['text', null]) {
			assert.isFalse(parse(SerializableDisknode, { ...metadata(PATH_A), contents }).ok);
		}
	});
});

describe('single-flight', () => {
	test('concurrent callers share one read', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const first = app.diskfiles.ensure_content(diskfile);
		const second = app.diskfiles.ensure_content(diskfile);
		assert.strictEqual(first, second);
		await flush();
		assert.strictEqual(reads.length, 1);
		await answer(PATH_A, read_ok('text'));
		await Promise.all([first, second]);
		assert.strictEqual(diskfile.content, 'text');
	});

	test('a loaded or unloadable file is not read again', async () => {
		const diskfile = await load(PATH_A, 'text');
		app.diskfiles.add_initial([metadata(PATH_B)]);
		const loading = app.diskfiles.ensure_content(get(PATH_B));
		await flush();
		await answer(PATH_B, read_ok(null, 'not_utf8'));
		await loading;
		assert.strictEqual(get(PATH_B).content_status, 'unloadable');
		await app.diskfiles.ensure_content(diskfile);
		await app.diskfiles.ensure_content(get(PATH_B));
		await flush();
		assert.strictEqual(reads.length, 0);
	});

	test('concurrent load_content retries share one read', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const failing = assert_rejects(() => app.diskfiles.load_content(diskfile), /connection lost/);
		await flush();
		await answer(PATH_A, read_error('connection lost'));
		await failing;

		const first = app.diskfiles.load_content(diskfile);
		const second = app.diskfiles.load_content(diskfile);
		await flush();
		assert.strictEqual(reads.length, 1);
		await answer(PATH_A, read_ok('text'));
		assert.deepEqual(await Promise.all([first, second]), ['text', 'text']);
	});
});

describe('stale while in flight', () => {
	test('a change during the read reads again, resolving with the newer content', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		let settled = false;
		const loading = app.diskfiles.ensure_content(diskfile).then(() => {
			settled = true;
		});
		await flush();

		change_on_disk(PATH_A);
		assert.strictEqual(reads.length, 1, 'the read in flight reads again, no second one');

		await answer(PATH_A, read_ok('old'));
		assert.strictEqual(diskfile.content, 'old', 'shown while the next read is in flight');
		assert.isFalse(settled, 'callers wait for the newer content');
		assert.strictEqual(reads.length, 1, 'read again');

		await answer(PATH_A, read_ok('new'));
		await loading;
		assert.strictEqual(diskfile.content, 'new');
	});

	test('a file written more often than a read takes still shows each content that lands', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		void app.diskfiles.ensure_content(diskfile);
		await flush();
		for (const version of ['v1', 'v2', 'v3']) {
			change_on_disk(PATH_A);
			await answer(PATH_A, read_ok(version));
			assert.strictEqual(diskfile.content, version);
		}
		await answer(PATH_A, read_ok('v4'));
		assert.strictEqual(diskfile.content, 'v4');
		assert.strictEqual(reads.length, 0, 'settled');
	});

	test('a failed read that is already stale is not applied, the next one is', async () => {
		const diskfile = await load(PATH_A, 'v1');
		app.diskfiles.get_editor_state(diskfile);
		change_on_disk(PATH_A);
		await flush();
		change_on_disk(PATH_A);
		await answer(PATH_A, read_error('flaky'));
		assert.isNull(diskfile.content_error);
		await answer(PATH_A, read_ok('v2'));
		assert.strictEqual(diskfile.content, 'v2');
	});

	test('a read stopped by a delete leaves the file unrequested, not loading', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const loading = app.diskfiles.ensure_content(diskfile);
		await flush();
		change_on_disk(PATH_A);
		app.diskfiles.remove_by_path(PATH_A);
		await answer(PATH_A, read_error('not found'));
		await loading;
		assert.strictEqual(diskfile.content_status, 'unrequested');
		assert.strictEqual(reads.length, 0);
	});

	test('a change on disk while a read waits for a slot costs no extra read', async () => {
		const paths = Array.from({ length: DISKFILE_READ_CONCURRENCY }, (_, i) =>
			to_path(`busy${i}.txt`)
		);
		app.diskfiles.add_initial(paths.map((path) => metadata(path)));
		for (const path of paths) void app.diskfiles.ensure_content(get(path));
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const loading = app.diskfiles.ensure_content(diskfile);
		await flush();
		assert.strictEqual(reads.length, DISKFILE_READ_CONCURRENCY, 'the read of a.txt is queued');

		change_on_disk(PATH_A);
		await answer(paths[0]!, read_ok('busy'));
		assert.strictEqual(reads.at(-1)!.path, PATH_A, 'a.txt took the freed slot');
		await answer(PATH_A, read_ok('text'));
		assert.isFalse(
			reads.some((read) => read.path === PATH_A),
			'one read of a.txt — it started after the change'
		);
		await loading;
		assert.strictEqual(diskfile.content, 'text');
	});

	test('load_content rejects for a file gone while it read', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const loading = assert_rejects(
			() => app.diskfiles.load_content(diskfile),
			/content not loaded — the file is gone/
		);
		await flush();
		app.diskfiles.remove_by_path(PATH_A);
		await answer(PATH_A, read_ok('text'));
		await loading;
	});

	test('load_content retries a failed read on an explicit ask', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		// the handler attached at once, so the rejection is never unhandled
		const first = assert_rejects(() => app.diskfiles.load_content(diskfile), /connection lost/);
		await flush();
		await answer(PATH_A, read_error('connection lost'));
		await first;
		await app.diskfiles.ensure_content(diskfile);
		await flush();
		assert.strictEqual(reads.length, 0, 'ensure_content does not retry');

		const second = app.diskfiles.load_content(diskfile);
		assert.strictEqual(diskfile.content_status, 'loading');
		assert.isNull(diskfile.content_error, 'the retry starts clean');
		await flush();
		assert.strictEqual(reads.length, 1, 'load_content does');
		await answer(PATH_A, read_ok('text'));
		assert.strictEqual(await second, 'text');
		assert.isNull(diskfile.content_error);
	});

	test('load_content does not retry a failed read for a file gone since', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const first = assert_rejects(() => app.diskfiles.load_content(diskfile), /connection lost/);
		await flush();
		await answer(PATH_A, read_error('connection lost'));
		await first;
		app.diskfiles.remove_by_path(PATH_A);

		await assert_rejects(() => app.diskfiles.load_content(diskfile), /connection lost/);
		await flush();
		assert.strictEqual(reads.length, 0);
		assert.strictEqual(diskfile.content_status, 'unloadable');
		assert.strictEqual(diskfile.content_error, 'connection lost');
	});

	test('a read for a file deleted meanwhile is dropped', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const loading = app.diskfiles.ensure_content(get(PATH_A));
		await flush();
		app.diskfiles.handle_change({
			change: { type: 'delete', path: PATH_A },
			disknode: metadata(PATH_A)
		});
		await answer(PATH_A, read_error('not found'));
		await loading;
		assert.isUndefined(app.diskfiles.get_by_path(PATH_A));
	});
});

describe('unloadable', () => {
	test('a read without text settles it unloadable with the reason', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const loading = app.diskfiles.ensure_content(diskfile);
		await flush();
		await answer(PATH_A, read_ok(null, 'too_large'));
		await loading;
		assert.strictEqual(diskfile.content_status, 'unloadable');
		assert.strictEqual(diskfile.unloaded_reason, 'too_large');
		assert.include(to_diskfile_unloaded_message(diskfile), 'over 4 MiB');
	});

	test('a failed first read settles it unloadable with the error, not retried by asking', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const loading = app.diskfiles.ensure_content(diskfile);
		await flush();
		await answer(PATH_A, read_error('no transport available'));
		await loading;
		assert.strictEqual(diskfile.content_status, 'unloadable');
		assert.strictEqual(diskfile.content_error, 'no transport available');
		assert.include(to_diskfile_unloaded_message(diskfile), 'no transport available');

		await app.diskfiles.ensure_content(diskfile);
		await flush();
		assert.strictEqual(reads.length, 0, "a view's effect can't loop on a failure");
	});

	test('a failed re-read keeps the content it had', async () => {
		const diskfile = await load(PATH_A, 'text');
		app.diskfiles.get_editor_state(diskfile);
		change_on_disk(PATH_A);
		await flush();
		await answer(PATH_A, read_error('network down'));
		assert.strictEqual(diskfile.content, 'text');
		assert.strictEqual(diskfile.content_error, 'network down');
	});

	test('load_content never retries a file too large to load', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const first = assert_rejects(
			() => app.diskfiles.load_content(diskfile),
			/content not loaded — the file is over 4 MiB/
		);
		await flush();
		await answer(PATH_A, read_ok(null, 'too_large'));
		await first;

		await assert_rejects(
			() => app.diskfiles.load_content(diskfile),
			/content not loaded — the file is over 4 MiB/
		);
		await flush();
		assert.strictEqual(reads.length, 0);
	});

	test('a failed read after one found the file too large says the error, not the old reason', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const loading = app.diskfiles.ensure_content(diskfile);
		await flush();
		await answer(PATH_A, read_ok(null, 'too_large'));
		await loading;
		app.diskfiles.get_editor_state(diskfile);

		change_on_disk(PATH_A);
		await flush();
		await answer(PATH_A, read_error('connection lost'));
		assert.strictEqual(diskfile.content_status, 'unloadable');
		assert.isNull(diskfile.unloaded_reason);
		const message = to_diskfile_unloaded_message(diskfile);
		assert.include(message, 'connection lost');
		assert.notInclude(message, 'over 4 MiB');
	});
});

describe('a change on disk', () => {
	test('re-reads a file with an editing state, keeping its content until the new lands', async () => {
		const diskfile = await load(PATH_A, 'v1');
		const editor_state = app.diskfiles.get_editor_state(diskfile);

		change_on_disk(PATH_A);
		assert.strictEqual(diskfile.content_status, 'loaded', 'no read-only flicker');
		assert.strictEqual(diskfile.content, 'v1');
		await flush();
		assert.strictEqual(reads.length, 1);

		await answer(PATH_A, read_ok('v2'));
		assert.strictEqual(diskfile.content, 'v2');
		assert.strictEqual(editor_state.current_content, 'v2', 'a clean editor follows the disk');
		assert.isFalse(editor_state.has_conflict);
		assert.ok(
			editor_state.history.entries.some((entry) => entry.label === HISTORY_LABEL_DISK_CHANGE)
		);
	});

	test('a re-read of the same text changes nothing in the editing state', async () => {
		const diskfile = await load(PATH_A, 'v1');
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.current_content = 'my draft';
		const entries = editor_state.history.entries.length;

		change_on_disk(PATH_A);
		await flush();
		await answer(PATH_A, read_ok('v1'));
		assert.strictEqual(editor_state.history.entries.length, entries);
		assert.isFalse(editor_state.disk_conflict, 'a touch is not a conflict');
	});

	test('re-reads a file a part references', async () => {
		await load(PATH_A, 'v1');
		app.parts.add({ type: 'diskfile', path: PATH_A });
		await flush();
		change_on_disk(PATH_A);
		await flush();
		assert.strictEqual(reads.length, 1);
		await answer(PATH_A, read_ok('v2'));
		assert.strictEqual(get(PATH_A).content, 'v2');
	});

	test('drops the content of a file nothing holds, to reload on next access', async () => {
		const diskfile = await load(PATH_A, 'v1');
		change_on_disk(PATH_A, 7);
		await flush();
		assert.strictEqual(reads.length, 0);
		assert.strictEqual(diskfile.content_status, 'unrequested');
		assert.isNull(diskfile.content);
		assert.strictEqual(diskfile.mtime, 7);

		const loading = app.diskfiles.ensure_content(diskfile);
		await flush();
		await answer(PATH_A, read_ok('v2'));
		await loading;
		assert.strictEqual(diskfile.content, 'v2');
	});

	test('drops an unloadable file nothing holds too — it may load now', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const loading = app.diskfiles.ensure_content(get(PATH_A));
		await flush();
		await answer(PATH_A, read_ok(null, 'too_large'));
		await loading;
		assert.strictEqual(get(PATH_A).content_status, 'unloadable');
		change_on_disk(PATH_A);
		assert.strictEqual(get(PATH_A).content_status, 'unrequested');
	});

	test('leaves an unrequested file alone', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		change_on_disk(PATH_A);
		await flush();
		assert.strictEqual(reads.length, 0);
		assert.strictEqual(get(PATH_A).content_status, 'unrequested');
	});

	test('a change of the timestamps alone follows the same policy', async () => {
		const held = await load(PATH_A, 'a');
		app.diskfiles.get_editor_state(held);
		const loose = await load(PATH_B, 'b');
		// a `touch` arrives as a `change`, metadata only like every one
		for (const path of [PATH_A, PATH_B]) change_on_disk(path, 3);
		await flush();
		assert.deepEqual(
			reads.map((r) => r.path),
			[PATH_A]
		);
		assert.strictEqual(loose.content_status, 'unrequested');
	});

	test('a new file a part references is read when it arrives', async () => {
		app.parts.add({ type: 'diskfile', path: PATH_A });
		await flush();
		app.diskfiles.handle_change({
			change: { type: 'add', path: PATH_A },
			disknode: metadata(PATH_A)
		});
		assert.strictEqual(get(PATH_A).content_status, 'loading');
		await flush();
		await answer(PATH_A, read_ok('text'));
		assert.strictEqual(get(PATH_A).content, 'text');
	});
});

describe('a file part attaching', () => {
	test('reads the file it references', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const part = app.parts.add({ type: 'diskfile', path: PATH_A });
		assert.strictEqual(part.type === 'diskfile' && part.content_status, 'unrequested');
		await flush();
		assert.strictEqual(reads.length, 1);
		await answer(PATH_A, read_ok('text'));
		assert.strictEqual(part.content, 'text');
	});

	test('stops holding the file once disposed', async () => {
		const diskfile = await load(PATH_A, 'v1');
		const part = app.parts.add({ type: 'diskfile', path: PATH_A });
		app.parts.remove(part.id);
		change_on_disk(PATH_A);
		await flush();
		assert.strictEqual(reads.length, 0);
		assert.strictEqual(diskfile.content_status, 'unrequested');
	});
});

describe('the first load of a file with an editing state', () => {
	test('seeds the original state — not a disk change, never a conflict', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		assert.isTrue(editor_state.content_loading);
		assert.isFalse(editor_state.can_edit, 'read-only while it loads');
		editor_state.current_content = 'typed early';
		assert.strictEqual(editor_state.current_content, '', 'ignored');

		const loading = app.diskfiles.ensure_content(diskfile);
		await flush();
		await answer(PATH_A, read_ok('text'));
		await loading;

		const { entries } = editor_state.history;
		assert.strictEqual(entries.length, 1);
		assert.isTrue(entries[0]!.is_original_state);
		assert.isFalse(entries[0]!.is_disk_change);
		assert.strictEqual(editor_state.selected_history_entry_id, entries[0]!.id);
		assert.strictEqual(editor_state.last_seen_disk_content, 'text');
		assert.strictEqual(editor_state.current_content, 'text');
		assert.isFalse(editor_state.disk_conflict);
		assert.isFalse(editor_state.dirty);
		assert.isTrue(editor_state.can_edit);
	});
});

describe('the markdown view mode', () => {
	test('a file still loading opens in split, one that can not load in preview', async () => {
		const path = to_path('notes.md');
		app.diskfiles.add_initial([metadata(path)]);
		const diskfile = get(path);
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		assert.strictEqual(editor_state.markdown_view_mode, 'split', 'unrequested');
		const loading = app.diskfiles.ensure_content(diskfile);
		assert.strictEqual(editor_state.markdown_view_mode, 'split', 'loading');
		await flush();
		await answer(path, read_ok(null, 'too_large'));
		await loading;
		assert.strictEqual(editor_state.markdown_view_mode, 'preview');
	});
});

describe('saving', () => {
	test('Diskfiles.update refuses while the content is loading', async () => {
		const update = vi.fn(() => Promise.resolve({ ok: true, value: null }));
		(app.api as unknown as Record<string, unknown>).diskfile_update = update;
		app.diskfiles.add_initial([metadata(PATH_A)]);
		void app.diskfiles.ensure_content(get(PATH_A));

		const result = await app.diskfiles.update(PATH_A, 'over it');
		assert.ok(!result.ok);
		assert.strictEqual((result.error.data as { reason: string }).reason, ERROR_CONTENT_NOT_LOADED);
		assert.include(result.error.message, DISKFILE_CONTENT_LOADING_MESSAGE);
		assert.strictEqual(update.mock.calls.length, 0);
	});
});

describe('reconnect', () => {
	test('a metadata snapshot re-reads the files held eagerly and drops the rest', async () => {
		const held = await load(PATH_A, 'a');
		const editor_state = app.diskfiles.get_editor_state(held);
		editor_state.current_content = 'draft';
		const loose = await load(PATH_B, 'b');
		app.diskfiles.add_initial([metadata(PATH_C)]);

		app.diskfiles.reconcile([metadata(PATH_A), metadata(PATH_B), metadata(PATH_C)], [SOURCE_DIR]);
		await flush();
		assert.deepEqual(
			reads.map((r) => r.path),
			[PATH_A]
		);
		assert.strictEqual(loose.content_status, 'unrequested');
		assert.strictEqual(get(PATH_C).content_status, 'unrequested');

		// unchanged while disconnected: the string compare keeps the draft clean of a conflict
		await answer(PATH_A, read_ok('a'));
		assert.isFalse(editor_state.disk_conflict);
		assert.strictEqual(editor_state.current_content, 'draft');
	});

	test('a change missed while disconnected is a conflict under a draft', async () => {
		const held = await load(PATH_A, 'a');
		const editor_state = app.diskfiles.get_editor_state(held);
		editor_state.current_content = 'draft';
		app.diskfiles.reconcile([metadata(PATH_A)], [SOURCE_DIR]);
		await flush();
		await answer(PATH_A, read_ok('changed elsewhere'));
		assert.isTrue(editor_state.has_conflict);
	});

	test('the shown file reads first, and at most the concurrency limit at once', async () => {
		const paths = Array.from({ length: DISKFILE_READ_CONCURRENCY + 2 }, (_, i) =>
			to_path(`f${i}.txt`)
		);
		for (const path of paths) {
			app.diskfiles.get_editor_state(await load(path, 'x'));
		}
		const shown = paths.at(-1)!;
		const tabbed = paths.at(-2)!;
		app.diskfiles.select(get(tabbed).id, true);
		app.diskfiles.select(get(shown).id, true);

		app.diskfiles.reconcile(
			paths.map((path) => metadata(path)),
			[SOURCE_DIR]
		);
		await flush();
		assert.strictEqual(reads.length, DISKFILE_READ_CONCURRENCY);
		assert.strictEqual(reads[0]!.path, shown, 'the selected tab first');
		assert.strictEqual(reads[1]!.path, tabbed, 'then the other tabs');

		await answer(reads[0]!.path, read_ok('x'));
		assert.strictEqual(reads.length, DISKFILE_READ_CONCURRENCY, 'a freed slot takes the next');
	});
});

describe('ensure_content in an $effect', () => {
	test('asks again after a change drops the content of a file nothing holds', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		const stop = run_in_effect(() => {
			void app.diskfiles.ensure_content(diskfile);
		});
		try {
			await flush();
			await answer(PATH_A, read_ok('v1'));
			assert.strictEqual(diskfile.content, 'v1');

			// a transcript view, say: no editing state, so a change drops the content
			change_on_disk(PATH_A);
			await flush();
			assert.strictEqual(reads.length, 1, 'the effect asked again');
			await answer(PATH_A, read_ok('v2'));
			assert.strictEqual(diskfile.content, 'v2');
		} finally {
			stop();
		}
	});

	test('never reads a diskfile gone from the collection', async () => {
		app.diskfiles.add_initial([metadata(PATH_A)]);
		const diskfile = get(PATH_A);
		app.diskfiles.remove_by_path(PATH_A);
		let read_count = 0;
		const read = app.api.diskfile_read;
		(app.api as unknown as Record<string, unknown>).diskfile_read = (input: {
			path: DiskfilePath;
		}) => {
			read_count++;
			return read(input);
		};
		const stop = run_in_effect(() => {
			void app.diskfiles.ensure_content(diskfile);
		});
		try {
			for (let i = 0; i < 5; i++) {
				await flush();
				for (const pending of reads.splice(0)) pending.deferred.resolve(read_ok('x'));
			}
			assert.strictEqual(read_count, 0);
			assert.strictEqual(diskfile.content_status, 'unrequested');
		} finally {
			stop();
		}
	});
});
