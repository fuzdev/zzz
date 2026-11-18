// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, beforeEach, describe, assert } from 'vitest';
import { create_deferred, type Deferred } from '@fuzdev/fuz_util/async.ts';

import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import type { DiskfilePart } from '#lib/part.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { flush_reads, install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

/**
 * A rename moves everything here that follows a file — its cell, draft,
 * tab, history, and parts — whichever arrives first, the daemon's reply or
 * the filer's delete and add, and nothing reads the file as deleted.
 */

const at = (path: string): DiskfilePath => parse_or_throw(DiskfilePath, path);
const A = at('/w/a.txt');
const B = at('/w/b.txt');
const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

type RenameReply =
	| { ok: true; value: { renamed: Array<{ path: DiskfilePath; new_path: DiskfilePath }> } }
	| { ok: false; error: { code: number; message: string; data?: { reason: string } } };

let app: Frontend;
let disk: FakeDisk;
let diskfile: Diskfile;
let reply: Deferred<RenameReply>;
let calls: Array<{ path: string; name: string }>;

beforeEach(async () => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
	diskfile = await disk.load(A, 'text');
	calls = [];
	reply = create_deferred<RenameReply>();
	(app.api as unknown as Record<string, unknown>).diskfile_rename = (input: {
		path: string;
		name: string;
	}) => {
		calls.push(input);
		return reply.promise;
	};
});

/** The daemon's reply for `pairs`, the bytes moved on the fake disk as the daemon moves them. */
const moved = (...pairs: Array<[DiskfilePath, DiskfilePath]>): RenameReply => {
	for (const [path, new_path] of pairs) disk.move(path, new_path);
	return { ok: true, value: { renamed: pairs.map(([path, new_path]) => ({ path, new_path })) } };
};

/** A tab on the file with a draft in it, and a turn's part referencing it. */
const open_with_draft = (): { draft_id: string; part: DiskfilePart } => {
	app.diskfiles.editor.open_diskfile(A);
	app.diskfiles.get_editor_state(diskfile).current_content = 'edited';
	const draft = app.diskfiles.drafts.get(A);
	assert.ok(draft);
	const part = app.parts.add({ type: 'diskfile', path: A }) as DiskfilePart;
	return { draft_id: draft.id, part };
};

const assert_followed = (draft_id: string, part: DiskfilePart): void => {
	const { diskfiles } = app;
	assert.strictEqual(diskfiles.peek(B), diskfile, 'the same cell');
	assert.isUndefined(diskfiles.peek(A));
	assert.strictEqual(diskfile.path, B);
	assert.isFalse(diskfile.deleted_on_disk, 'never read as deleted');
	assert.strictEqual(diskfiles.drafts.get(B)?.id, draft_id, 'the same draft');
	assert.strictEqual(diskfiles.drafts.get(B)?.text, 'edited');
	assert.isFalse(diskfiles.drafts.has(A));
	assert.strictEqual(diskfiles.editor.tabs.selected_path, B);
	assert.isFalse(diskfiles.editor.tabs.by_path.has(A));
	assert.strictEqual(diskfiles.find_editor_state(B)?.current_content, 'edited');
	assert.strictEqual(part.path, B);
	assert.ok(diskfiles.index.get(B), 'its record at the new path');
	assert.isUndefined(diskfiles.index.get(A));
};

describe('Diskfiles.rename', () => {
	test('the reply first, then the filer: everything follows', async () => {
		const { draft_id, part } = open_with_draft();
		const renaming = app.diskfiles.rename(A, 'b.txt');
		assert.deepEqual(calls, [{ path: A, name: 'b.txt' }]);

		reply.resolve(moved([A, B]));
		const result = await renaming;
		assert.deepEqual(result, { ok: true, value: { path: B } });
		assert_followed(draft_id, part);

		// the filer's late delete and add change nothing
		app.diskfiles.remove_by_path(A);
		app.diskfiles.upsert(disk.disknode(B));
		await flush_reads();
		assert_followed(draft_id, part);
	});

	test('the filer first, in either order: nothing reads as deleted', async () => {
		for (const delete_first of [true, false]) {
			app = monkeypatch_zzz_for_tests(new Frontend());
			disk = install_fake_disk(app, SOURCE_DIR);
			diskfile = await disk.load(A, 'text');
			reply = create_deferred<RenameReply>();
			(app.api as unknown as Record<string, unknown>).diskfile_rename = () => reply.promise;
			const { draft_id, part } = open_with_draft();

			const renaming = app.diskfiles.rename(A, 'b.txt');
			if (delete_first) app.diskfiles.remove_by_path(A);
			app.diskfiles.upsert(disk.disknode(B));
			if (!delete_first) app.diskfiles.remove_by_path(A);
			assert.isFalse(diskfile.deleted_on_disk, `pending, delete_first: ${delete_first}`);

			reply.resolve(moved([A, B]));
			await renaming;
			assert_followed(draft_id, part);
		}
	});

	test('a failed rename moves nothing, and applies a delete reported meanwhile', async () => {
		const { draft_id } = open_with_draft();
		const renaming = app.diskfiles.rename(A, 'b.txt');
		app.diskfiles.remove_by_path(A); // deleted on disk by someone else meanwhile
		reply.resolve({
			ok: false,
			error: { code: -32603, message: 'failed', data: { reason: 'path_not_found' } }
		});
		const result = await renaming;
		assert.isFalse(result.ok);
		assert.strictEqual(app.diskfiles.peek(A), diskfile);
		assert.isTrue(diskfile.deleted_on_disk, 'the delete applied');
		assert.strictEqual(app.diskfiles.drafts.get(A)?.id, draft_id);
		assert.strictEqual(app.diskfiles.editor.tabs.selected_path, A);
	});

	test("a sidecar's tab moves with its audio", async () => {
		const audio = at('/w/rec.webm');
		const sidecar = at('/w/rec.webm.m.transcript.json');
		const renamed_audio = at('/w/talk.webm');
		const renamed_sidecar = at('/w/talk.webm.m.transcript.json');
		await disk.load(audio, null);
		await disk.load(sidecar, '{}');
		app.diskfiles.editor.open_diskfile(sidecar);

		const renaming = app.diskfiles.rename(audio, 'talk.webm');
		reply.resolve(moved([audio, renamed_audio], [sidecar, renamed_sidecar]));
		assert.isTrue((await renaming).ok);
		assert.strictEqual(app.diskfiles.editor.tabs.selected_path, renamed_sidecar);
		assert.isFalse(app.diskfiles.editor.tabs.by_path.has(sidecar));
	});

	test('the file_rename intent renames, and lands in the recent intents', async () => {
		app.diskfiles.editor.open_diskfile(A);
		const renaming = app.intents.file_rename({ path: A, name: 'b.txt' });
		reply.resolve(moved([A, B]));
		const result = await renaming;
		assert.isTrue(result.ok);
		assert.strictEqual(app.diskfiles.editor.tabs.selected_path, B);
		const refused = await app.intents.file_rename({ path: B, name: 'b.txt' });
		assert.isFalse(refused.ok);
		assert.deepEqual(
			app.recent_intents.entries
				.filter((entry) => entry.method === 'file_rename')
				.map((entry) => entry.outcome),
			['applied', 'failed']
		);
	});

	test('a file with no cell, its delete first: its record moves, none left behind', async () => {
		const C = at('/w/c.txt');
		const D = at('/w/d.txt');
		app.diskfiles.upsert(disk.disknode(C));
		assert.isUndefined(app.diskfiles.peek(C));
		const renaming = app.diskfiles.rename(C, 'd.txt');
		app.diskfiles.remove_by_path(C);
		reply.resolve(moved([C, D]));
		assert.isTrue((await renaming).ok);
		assert.isUndefined(app.diskfiles.index.get(C), 'no ghost at the old path');
		assert.ok(app.diskfiles.index.get(D));
	});

	test('a save during the rename waits, then writes at the new path', async () => {
		delete (app.diskfiles as { update?: unknown }).update;
		app.diskfiles.editor.open_diskfile(A);
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.current_content = 'edited';
		const renaming = app.diskfiles.rename(A, 'b.txt');
		const saving = editor_state.save_changes();
		await flush_reads();
		assert.deepEqual(disk.updates, [], 'nothing written to the name being left');
		reply.resolve(moved([A, B]));
		await renaming;
		await saving;
		assert.deepEqual(
			disk.updates.map((u) => u.path),
			[B]
		);
	});

	test("a sidecar's early delete doesn't flag it deleted", async () => {
		const audio = at('/w/rec.webm');
		const sidecar = at('/w/rec.webm.m.transcript.json');
		await disk.load(audio, null);
		const sidecar_file = await disk.load(sidecar, '{}');
		app.diskfiles.editor.open_diskfile(sidecar);
		const renaming = app.diskfiles.rename(audio, 'talk.webm');
		app.diskfiles.remove_by_path(sidecar);
		assert.isFalse(sidecar_file.deleted_on_disk);
		reply.resolve(
			moved([audio, at('/w/talk.webm')], [sidecar, at('/w/talk.webm.m.transcript.json')])
		);
		await renaming;
		assert.isFalse(sidecar_file.deleted_on_disk);
		assert.strictEqual(sidecar_file.path, '/w/talk.webm.m.transcript.json');
	});

	test("a sidecar's new name open here refuses the rename", async () => {
		const audio = at('/w/rec.webm');
		await disk.load(audio, null);
		await disk.load(at('/w/rec.webm.m.transcript.json'), '{}');
		const taken = await disk.load(at('/w/talk.webm.m.transcript.json'), '{}');
		app.diskfiles.editor.open_diskfile(taken.path);
		const result = await app.diskfiles.rename(audio, 'talk.webm');
		assert.isFalse(result.ok);
		if (!result.ok) assert.deepEqual(result.error.data, { reason: 'already_exists' });
		assert.deepEqual(calls, []);
	});

	test('a rejected call applies a delete reported meanwhile', async () => {
		app.diskfiles.editor.open_diskfile(A);
		const renaming = app.diskfiles.rename(A, 'b.txt');
		app.diskfiles.remove_by_path(A);
		reply.reject(new Error('socket closed'));
		const result = await renaming;
		assert.isFalse(result.ok);
		assert.isTrue(diskfile.deleted_on_disk);
	});

	test('an uncovered file renamed onto a covered name the filer reported first is covered', async () => {
		app.diskfiles.editor.open_diskfile(A);
		app.diskfiles.set_uncovered(diskfile, true);
		const renaming = app.diskfiles.rename(A, 'b.txt');
		// the filer's add, then a change someone else made — both before the reply
		disk.move(A, B);
		app.diskfiles.upsert(disk.disknode(B));
		// a change reported by another filer, under a nested root
		const nested = parse_or_throw(SerializableDisknode.def.source_dir, '/w/sub/');
		app.diskfiles.upsert({ ...disk.disknode(B), size: 99, mtime: 77, source_dir: nested });
		reply.resolve({ ok: true, value: { renamed: [{ path: A, new_path: B }] } });
		assert.isTrue((await renaming).ok);
		assert.isFalse(diskfile.uncovered);
		assert.strictEqual(app.diskfiles.index.get(B)?.size, 99, 'the newest report kept');
		assert.strictEqual(diskfile.mtime, 77, 'and taken onto the cell');
		assert.strictEqual(diskfile.source_dir, nested, "the report's root taken too");
	});

	test('a file edited at the new name meanwhile is kept, and the old one shows deleted', async () => {
		app.diskfiles.editor.open_diskfile(A);
		const renaming = app.diskfiles.rename(A, 'b.txt');
		app.diskfiles.remove_by_path(A);
		disk.move(A, B);
		const b_file = await disk.load(B, 'text');
		app.diskfiles.editor.open_diskfile(B);
		app.diskfiles.get_editor_state(b_file).current_content = 'edited at b';
		reply.resolve({ ok: true, value: { renamed: [{ path: A, new_path: B }] } });
		assert.isTrue((await renaming).ok);
		assert.strictEqual(app.diskfiles.peek(B), b_file);
		assert.strictEqual(app.diskfiles.find_editor_state(B)?.current_content, 'edited at b');
		assert.strictEqual(app.diskfiles.peek(A), diskfile);
		assert.isTrue(diskfile.deleted_on_disk, 'no ghost: gone from disk, shown so');
	});

	test('refused here, before the daemon', async () => {
		const refused = async (name: string, reason?: string): Promise<void> => {
			const result = await app.diskfiles.rename(A, name);
			assert.isFalse(result.ok, name);
			if (reason !== undefined && !result.ok) {
				assert.deepEqual(result.error.data, { reason }, name);
			}
		};
		for (const name of ['', '.', '..', 'x/y.txt', 'x\\y.txt', 'a.txt']) await refused(name);

		// a new path with a tab here
		await disk.load(B, 'other');
		app.diskfiles.editor.open_diskfile(B);
		await refused('b.txt', 'already_exists');

		// a file being saved
		const editor_state = app.diskfiles.get_editor_state(diskfile);
		editor_state.saving = true;
		await refused('c.txt');
		editor_state.saving = false;

		assert.deepEqual(calls, [], 'the daemon never asked');
	});
});
