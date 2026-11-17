import {
	array,
	brand,
	check,
	message,
	nullable,
	number,
	object,
	one_of,
	pipe,
	safe_integer,
	integer,
	min_value,
	string,
	unknown,
	with_default,
	type Infer,
	type InferInput,
	type Schema
} from '@fuzdev/fuz_schema/schema.ts';

import { cell_json_schema } from './cell_types.ts';
import { is_path_absolute } from './diskfile_helpers.ts';
import { PathWithTrailingSlash } from './path_schemas.ts';

/**
 * What happened to a file the backend indexes:
 *
 * - `add` — it's newly indexed
 * - `change` — its contents, size, or timestamps moved — a `touch` or a
 *   rewrite of the same bytes included
 * - `delete` — it's gone
 *
 * A notification carries the file's metadata, never its contents, so the
 * frontend takes an `add` or `change` as a sign the file may have changed:
 * a file it holds eagerly is read again, any other loses its loaded content
 * (see `Diskfiles.upsert`).
 */
export const DiskfileChangeType = one_of(['add', 'change', 'delete']);
export type DiskfileChangeType = Infer<typeof DiskfileChangeType>;

/** An absolute Unix-style file path. */
export const DiskfilePath = brand(
	pipe(
		string,
		// an arrow, not `is_path_absolute` itself: `diskfile_helpers.ts` imports this module back
		message(
			check((p: string) => is_path_absolute(p)),
			'path must be absolute'
		)
	),
	'DiskfilePath'
);
export type DiskfilePath = Infer<typeof DiskfilePath>;

/** These always have a trailing slash. A `DiskfileDirectoryPath` is a `DiskfilePath`. */
export const DiskfileDirectoryPath = brand(
	pipe(PathWithTrailingSlash, DiskfilePath),
	'DiskfileDirectoryPath'
);
export type DiskfileDirectoryPath = Infer<typeof DiskfileDirectoryPath>;

export const DiskfileChange = object({
	type: DiskfileChangeType,
	path: DiskfilePath
});
export type DiskfileChange = Infer<typeof DiskfileChange>;

/**
 * Why a file's contents aren't loaded as text: over the backend's size
 * limit (4 MiB), or not valid UTF-8.
 */
export const DiskfileUnloadedReason = one_of(['too_large', 'not_utf8']);
export type DiskfileUnloadedReason = Infer<typeof DiskfileUnloadedReason>;

/**
 * A file's size in bytes as the backend sends it, `null` when it can't say —
 * any whole number: a sparse file can pass 2^53 bytes, which reads imprecisely
 * but must never refuse the whole reply it's in.
 */
export const WireSize = nullable(pipe(number, integer, min_value(0)));

/**
 * A timestamp the backend sends, whole milliseconds since the epoch, `null`
 * when it can't say — the backend sends `null` for one before the epoch or
 * past 9999-12-31 (the last RFC 3339 year, which `Datetime` requires), so a
 * valid one always converts.
 */
export const WireTime = nullable(pipe(number, safe_integer, min_value(0)));

// TODO hacky, uses the serializable form of the Gro `Disknode` (which uses maps)
/**
 * A file the backend indexes — its metadata, never its contents, which the
 * frontend reads when it needs them (`diskfile_read`). `size` is the file's
 * size in bytes — `null` when the backend can't say (a deleted file's node).
 * `ctime` (the birth time) / `mtime` are whole milliseconds since the epoch,
 * `null` when the backend can't say.
 */
export const SerializableDisknode = object({
	id: DiskfilePath,
	source_dir: DiskfileDirectoryPath,
	size: WireSize,
	ctime: WireTime,
	mtime: WireTime
});
export type SerializableDisknode = Infer<typeof SerializableDisknode>;

/**
 * A file of a snapshot, relative to its group's `dir` (`SnapshotFileGroup`):
 * `[rel, size, mtime, ctime?]` — the path below `dir`, then
 * `SerializableDisknode`'s `size`, `mtime`, and `ctime`, the last left off
 * when it equals `mtime`. `decode_snapshot_files` turns it back into a
 * `SerializableDisknode`.
 */
export type SnapshotFile =
	| [rel: string, size: number | null, mtime: number | null]
	| [rel: string, size: number | null, mtime: number | null, ctime: number | null];

const is_wire_size = (v: unknown): boolean =>
	v === null || (Number.isInteger(v) && (v as number) >= 0);
const is_wire_time = (v: unknown): boolean =>
	v === null || (Number.isSafeInteger(v) && (v as number) >= 0);

/**
 * Whether `v` is a `SnapshotFile`: a 3- or 4-tuple whose `rel` is a
 * non-empty path that doesn't start with `/`, whose size is a non-negative
 * whole number and whose times are non-negative safe integers, each or `null`.
 */
export const is_snapshot_file = (v: unknown): v is SnapshotFile =>
	Array.isArray(v) &&
	(v.length === 3 || v.length === 4) &&
	typeof v[0] === 'string' &&
	v[0] !== '' &&
	!v[0].startsWith('/') &&
	is_wire_size(v[1]) &&
	is_wire_time(v[2]) &&
	(v.length === 3 || is_wire_time(v[3]));

/** The schema of a `SnapshotFile` — fuz_schema has no tuple, so it's a checked `unknown`. */
export const SnapshotFile = pipe(
	unknown,
	message(check(is_snapshot_file), 'expected [rel, size, mtime, ctime?]')
) as Schema<SnapshotFile>;

/** The files of one filer dir in a snapshot, each relative to `dir`. */
export const SnapshotFileGroup = object({
	dir: DiskfileDirectoryPath,
	files: array(SnapshotFile)
});
export type SnapshotFileGroup = Infer<typeof SnapshotFileGroup>;

/**
 * The files of a snapshot reply (`session_load`, `project_open`,
 * `repo_focus`, `repo_files`), one group per filer dir — the compact form of
 * an array of `SerializableDisknode`, which a large tree would make several
 * times larger. `decode_snapshot_files` turns it into one.
 */
export const SnapshotFiles = array(SnapshotFileGroup);
export type SnapshotFiles = Infer<typeof SnapshotFiles>;

/**
 * Where a diskfile's content stands — see `Diskfile.content_status`:
 *
 * - `unrequested` — not loaded, and nothing asked for it yet
 * - `loading` — a read is on its way
 * - `loaded` — `Diskfile.content` holds it
 * - `unloadable` — the read found no text to load (`Diskfile.unloaded_reason`)
 *   or failed (`Diskfile.content_error`)
 */
export const DiskfileContentStatus = one_of(['unrequested', 'loading', 'loaded', 'unloadable']);
export type DiskfileContentStatus = Infer<typeof DiskfileContentStatus>;

/** `DiskfileContentStatus` without `loaded` — where the content stands while there's none. */
export type DiskfileUnloadedStatus = Exclude<DiskfileContentStatus, 'loaded'>;

/**
 * A file on disk. `path` and `source_dir` are required — a diskfile is
 * always for one file. `content` is `null` until it's loaded (see
 * `Diskfile.content_status`).
 */
export const DiskfileJson = cell_json_schema(
	{
		path: DiskfilePath,
		source_dir: DiskfileDirectoryPath,
		content: with_default(nullable(string), null),
		/**
		 * The file's size on disk in bytes — `null` when the backend couldn't
		 * say. Known whether or not `content` is loaded, and taken from the
		 * index alone: a content read (`diskfile_read`) doesn't change it, so a
		 * read racing a write can leave it briefly apart from `content`'s length.
		 */
		size: with_default(nullable(number), null),
		/**
		 * When the file was last modified on disk, in milliseconds since the
		 * epoch — `null` when the backend couldn't say. It moves whenever the
		 * file's bytes do, including for a file whose content isn't loaded.
		 */
		mtime: with_default(nullable(number), null)
	},
	'Diskfile'
);
export type DiskfileJson = Infer<typeof DiskfileJson>;
export type DiskfileJsonInput = InferInput<typeof DiskfileJson>;
