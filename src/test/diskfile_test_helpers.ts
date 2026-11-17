import { untrack } from 'svelte';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { create_deferred } from '@fuzdev/fuz_util/async.ts';
import { hash_blake3 } from '@fuzdev/fuz_util/hash_blake3.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';

import {
	DiskfilePath,
	SerializableDisknode,
	SnapshotFiles,
	type DiskfileDirectoryPath,
	type SnapshotFile
} from '#lib/diskfile_types.ts';
import { decode_snapshot_files, disknode_to_diskfile_json } from '#lib/diskfile_helpers.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import type { Frontend } from '#lib/frontend.svelte.ts';

/**
 * A file's content hash as the backend computes it (`diskfile_read`'s
 * `hash`, `diskfile_update`'s): BLAKE3 of its UTF-8 bytes, bare lowercase hex.
 */
export const content_hash = (content: string): string => hash_blake3(content);

/** A `diskfile_update` success as the backend answers it: the written bytes' hash. */
export const update_ok = (content: string): { ok: true; value: { hash: string } } => ({
	ok: true,
	value: { hash: content_hash(content) }
});

/**
 * What a test answers a held `diskfile_update` with — success, whose hash
 * `answer_update` fills in from the content written, or the error.
 */
export type HeldUpdateResult =
	{ ok: true; value?: unknown } | { ok: false; error: JsonrpcErrorObject };

/** The `diskfile_update` result a held write of `content` answers with `result`. */
export const answer_update = (
	content: string,
	result: HeldUpdateResult
): { ok: true; value: { hash: string } } | { ok: false; error: JsonrpcErrorObject } =>
	result.ok ? update_ok(content) : result;

/**
 * Encodes `disknodes` as a snapshot reply carries them (`SnapshotFiles`), as
 * the backend does: grouped by `source_dir` in sorted order, each path
 * relative to it, `ctime` left off when it equals `mtime`.
 */
export const encode_snapshot_files = (disknodes: Array<SerializableDisknode>): SnapshotFiles => {
	const groups: Map<DiskfileDirectoryPath, Array<SnapshotFile>> = new Map();
	for (const { id, source_dir, size, ctime, mtime } of disknodes) {
		if (!id.startsWith(source_dir)) throw Error(`${id} is outside ${source_dir}`);
		let files = groups.get(source_dir);
		if (!files) groups.set(source_dir, (files = []));
		const rel = id.slice(source_dir.length);
		files.push(ctime === mtime ? [rel, size, mtime] : [rel, size, mtime, ctime]);
	}
	return Array.from(groups, ([dir, files]) => ({ dir, files })).sort((a, b) =>
		a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0
	);
};

/**
 * A snapshot reply's `files` as the app reads them: parsed by the strict
 * `SnapshotFiles` schema, then decoded (`decode_snapshot_files`).
 */
export const parse_snapshot_files = (files: unknown): Array<SerializableDisknode> =>
	decode_snapshot_files(parse_or_throw(SnapshotFiles, files));

/** Lets queued content reads start and landed ones apply. */
export const flush_reads = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The files behind a test app's `diskfile_read`. The backend's disknodes
 * carry metadata only, so a test that wants a file's content in the app
 * writes it here, and the app reads it back as it would from the backend.
 */
export interface FakeDisk {
	/**
	 * What each path reads as: its text, or `null` for a file that can't load
	 * as text (read as not UTF-8). A read of a path missing here fails as the
	 * backend's does (`not_found`, `path_not_found`).
	 */
	readonly files: Map<string, string | null>;
	/** Every path read, in order. */
	readonly reads: Array<string>;
	/** The disknode the filer reports for `path` now — metadata only. */
	disknode: (path: string) => SerializableDisknode;
	/**
	 * Writes `path` here and reports it as the filer does (`filer_change`,
	 * metadata only) — what the app then does is its own: a file held eagerly
	 * (an editing state, or a part's) reads it back once `flush_reads` lets
	 * the read land, and any other is left `unrequested`. `type` is the change
	 * reported, by default `add` for a path the app doesn't hold and `change`
	 * for one it does.
	 */
	write: (path: string, contents: string | null, type?: 'add' | 'change') => Diskfile;
	/**
	 * Writes `path` as `write` does, then loads it in the app through its own
	 * read (`Diskfiles.ensure_content`) — a file as a view would find it.
	 */
	load: (path: string, contents: string | null, type?: 'add' | 'change') => Promise<Diskfile>;
	/**
	 * Holds every read until the returned release is called — a read in
	 * flight, for a test to act while the app waits on it. Reads answer with
	 * what the disk holds at release.
	 */
	hold_reads: () => () => void;
	/**
	 * Fails the next `count` reads with `message`, as a dropped socket or a
	 * read error would — each failure decided when the read answers.
	 */
	fail_reads: (count: number, message?: string) => void;
	/**
	 * Every `diskfile_update` the app sent, in order. The fake answers it as
	 * the backend does — with `expected_hash`, only if the file still holds
	 * those bytes (else `conflict` / `disk_changed`) — and writes `files`
	 * without reporting the change: a test reports it (`write`) when the
	 * filer would have.
	 */
	readonly updates: Array<{ path: string; content: string; expected_hash?: string }>;
	/**
	 * Every `diskfile_create` the app sent, in order. The fake answers it as
	 * the backend does — refused with `conflict` / `already_exists` when the
	 * path holds a file, writing nothing — and, like `updates`, reports
	 * nothing.
	 */
	readonly creates: Array<{ path: string; content: string }>;
	/**
	 * Holds every `diskfile_update` until the returned release is called — a
	 * save in flight, for a test to change the disk before the backend's
	 * compare. Each answers by what the disk holds at release.
	 */
	hold_updates: () => () => void;
}

/**
 * Puts a `FakeDisk` behind `app`: replaces `app.api` with one answering
 * `diskfile_read`, `diskfile_update`, and `diskfile_create` from it — a test needing other
 * methods adds them. (`monkeypatch_zzz_for_tests` replaces
 * `Diskfiles.update` itself, so a test saving through this disk deletes
 * that stub.)
 */
export const install_fake_disk = (
	app: Frontend,
	source_dir: DiskfileDirectoryPath | string
): FakeDisk => {
	const dir = parse_or_throw(SerializableDisknode.def.source_dir, source_dir);
	const files: Map<string, string | null> = new Map();
	const reads: Array<string> = [];
	// each write moves its file's mtime, as a write on disk does
	const mtimes: Map<string, number> = new Map();
	const sizes: Map<string, number> = new Map();
	let held: Promise<void> | null = null;
	const failures: Array<string> = [];
	const updates: FakeDisk['updates'] = [];
	const creates: FakeDisk['creates'] = [];
	let held_updates: Promise<void> | null = null;

	const disknode = (path: string): SerializableDisknode => ({
		id: parse_or_throw(DiskfilePath, path),
		source_dir: dir,
		size: sizes.get(path) ?? null,
		ctime: 1,
		mtime: mtimes.get(path) ?? 1
	});

	(app as unknown as { api: unknown }).api = {
		diskfile_read: async ({ path }: { path: string }) => {
			reads.push(path);
			if (held) await held;
			const failure = failures.shift();
			if (failure !== undefined) {
				return { ok: false, error: { code: -32603, message: failure } };
			}
			if (!files.has(path)) {
				// as the backend answers a missing file
				return {
					ok: false,
					error: {
						code: -32003,
						message: `failed to read file: No such file or directory: ${path}`,
						data: { reason: 'path_not_found' }
					}
				};
			}
			const contents = files.get(path)!;
			return {
				ok: true,
				value: {
					contents,
					unloaded_reason: contents === null ? 'not_utf8' : null,
					hash: contents === null ? null : content_hash(contents),
					size: sizes.get(path) ?? 0,
					ctime: 1,
					mtime: mtimes.get(path) ?? 1
				}
			};
		},
		diskfile_update: async (input: { path: string; content: string; expected_hash?: string }) => {
			updates.push(input);
			if (held_updates) await held_updates;
			const { path, content, expected_hash } = input;
			if (expected_hash !== undefined) {
				const current = files.get(path);
				if (current == null || content_hash(current) !== expected_hash) {
					return {
						ok: false,
						error: {
							code: -32004,
							message: `failed to write file: File changed on disk since it was read: ${path}`,
							data: { reason: 'disk_changed' }
						}
					};
				}
			}
			files.set(path, content);
			sizes.set(path, new TextEncoder().encode(content).length);
			mtimes.set(path, (mtimes.get(path) ?? 1) + 1);
			return update_ok(content);
		},
		diskfile_create: (input: { path: string; content: string }) => {
			creates.push(input);
			const { path, content } = input;
			if (files.has(path)) {
				return Promise.resolve({
					ok: false,
					error: {
						code: -32004,
						message: `failed to create file: File already exists: ${path}`,
						data: { reason: 'already_exists' }
					}
				});
			}
			files.set(path, content);
			sizes.set(path, new TextEncoder().encode(content).length);
			mtimes.set(path, (mtimes.get(path) ?? 1) + 1);
			return Promise.resolve({ ok: true, value: null });
		}
	};

	const write: FakeDisk['write'] = (path, contents, type) => {
		files.set(path, contents);
		sizes.set(path, contents === null ? 1 : new TextEncoder().encode(contents).length);
		mtimes.set(path, (mtimes.get(path) ?? 1) + 1);
		const node = disknode(path);
		const known = app.diskfiles.has_path(node.id);
		// a cell for the test to hold on to, as the app makes for a file something holds
		if (!app.diskfiles.peek(node.id)) app.diskfiles.add(disknode_to_diskfile_json(node));
		app.diskfiles.handle_change({
			change: { type: type ?? (known ? 'change' : 'add'), path: node.id },
			disknode: node
		});
		return app.diskfiles.peek(node.id)!;
	};

	return {
		files,
		reads,
		disknode,
		write,
		load: async (path, contents, type) => {
			const diskfile = write(path, contents, type);
			await app.diskfiles.ensure_content(diskfile);
			return diskfile;
		},
		updates,
		creates,
		hold_updates: () => {
			const deferred = create_deferred<void>();
			held_updates = deferred.promise;
			return () => {
				held_updates = null;
				deferred.resolve();
			};
		},
		fail_reads: (count, message = 'read failed') => {
			for (let i = 0; i < count; i++) failures.push(message);
		},
		hold_reads: () => {
			const deferred = create_deferred<void>();
			held = deferred.promise;
			return () => {
				held = null;
				deferred.resolve();
			};
		}
	};
};

/**
 * The cell at `path` as a test reaches for it — the one there, else one
 * made from the index's record and kept until the path is released (see
 * `Diskfiles.add`), as every file had one before cells were made on
 * demand; `undefined` when no file is known there. Unlike `acquire` it
 * doesn't hold the path, so the file isn't held eagerly. Untracked, so a
 * test can call it in an effect.
 */
export const seed_diskfile = (app: Frontend, path: string): Diskfile | undefined =>
	untrack(() => {
		const { diskfiles } = app;
		const diskfile_path = path as DiskfilePath;
		const existing = diskfiles.peek(diskfile_path);
		if (existing) return existing;
		const record = diskfiles.get_by_path(diskfile_path);
		if (!record) return undefined;
		const diskfile = diskfiles.add(disknode_to_diskfile_json(record));
		// `add` makes the record from the cell, which keeps no `ctime`
		diskfiles.upsert(record);
		return diskfile;
	});
