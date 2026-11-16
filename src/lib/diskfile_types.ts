import {
	brand,
	check,
	message,
	nullable,
	number,
	object,
	one_of,
	optional,
	pipe,
	string,
	with_default,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';

import { cell_json_schema } from './cell_types.ts';
import { is_path_absolute } from './diskfile_helpers.ts';
import { PathWithTrailingSlash } from './path_schemas.ts';

/**
 * What happened to a file the backend indexes:
 *
 * - `add` — it's newly indexed
 * - `change` — its contents differ
 * - `touch` — its metadata changed and the contents the backend holds for
 *   it didn't (a `touch`, a rewrite of the same bytes), so they aren't sent
 *   again. The backend holds no contents for a file it didn't load
 *   (`contents: null`), so every change to such a file is a `touch`
 * - `delete` — it's gone
 *
 * The frontend treats a notification without contents — every `touch` —
 * as a sign the file may have changed: a file it holds eagerly is read
 * again, any other loses its loaded content (see `Diskfiles.upsert`).
 */
export const DiskfileChangeType = one_of(['add', 'change', 'touch', 'delete']);
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

// TODO hacky, uses the serializable form of the Gro `Disknode` (which uses maps)
/**
 * A file the backend indexes. `size` is the file's size in bytes, known
 * whether or not its contents are loaded — `null` when the backend can't
 * say (a deleted file's node). `ctime` / `mtime` are milliseconds since the
 * epoch, `null` when the backend can't say.
 *
 * `contents` is optional: a node without it carries metadata only, and the
 * frontend reads the contents when it needs them (`diskfile_read`). Present,
 * it's a read the frontend takes as loaded — a string, or `null` for a file
 * whose contents can't be loaded as text (over 4 MiB, not UTF-8, or
 * unreadable).
 */
export const SerializableDisknode = object({
	id: DiskfilePath,
	source_dir: DiskfileDirectoryPath,
	contents: optional(nullable(string)),
	size: nullable(number),
	ctime: nullable(number),
	mtime: nullable(number)
});
export type SerializableDisknode = Infer<typeof SerializableDisknode>;

/**
 * A disknode without its contents — what a `touch` change carries. It has no
 * `contents` key, which is not `contents: null`: `null` says the file's
 * contents can't be loaded, and this says nothing about them.
 */
const { contents: _contents, ...disknode_metadata_entries } = SerializableDisknode.def;
export const DisknodeMetadata = object(disknode_metadata_entries);
export type DisknodeMetadata = Infer<typeof DisknodeMetadata>;

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
