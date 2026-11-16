import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { create_deferred } from '@fuzdev/fuz_util/async.ts';

import {
	DiskfilePath,
	SerializableDisknode,
	type DiskfileDirectoryPath
} from '#lib/diskfile_types.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import type { Frontend } from '#lib/frontend.svelte.ts';

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
	 * as text (read as not UTF-8). A read of a path missing here fails.
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
}

/**
 * Puts a `FakeDisk` behind `app`: replaces `app.api` with one answering
 * `diskfile_read` from it — a test needing other methods adds them.
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
				return { ok: false, error: { code: -32602, message: 'not found' } };
			}
			const contents = files.get(path)!;
			return {
				ok: true,
				value: {
					contents,
					unloaded_reason: contents === null ? 'not_utf8' : null,
					size: sizes.get(path) ?? 0,
					ctime: 1,
					mtime: mtimes.get(path) ?? 1
				}
			};
		}
	};

	const write: FakeDisk['write'] = (path, contents, type) => {
		files.set(path, contents);
		sizes.set(path, contents === null ? 1 : new TextEncoder().encode(contents).length);
		mtimes.set(path, (mtimes.get(path) ?? 1) + 1);
		const node = disknode(path);
		app.diskfiles.handle_change({
			change: {
				type: type ?? (app.diskfiles.get_by_path(node.id) ? 'change' : 'add'),
				path: node.id
			},
			disknode: node
		});
		return app.diskfiles.get_by_path(node.id)!;
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
