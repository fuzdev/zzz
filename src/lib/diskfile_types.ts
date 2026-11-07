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
	string,
	transform,
	unknown,
	with_default,
	with_default_fn,
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
 * A disknode's edge to another: the other's path and data the frontend never
 * reads. fuz_schema has no `tuple`, so it's an array checked to hold two items,
 * the first an absolute path.
 */
// TODO the backend always sends these empty and the frontend reads only their
// `length`; drop `dependents`/`dependencies` on both sides
const DisknodeEdge = pipe(
	array(unknown),
	check(
		(v: Array<unknown>) => v.length === 2 && typeof v[0] === 'string' && is_path_absolute(v[0]),
		'[DiskfilePath, unknown]'
	),
	// types the checked array as the tuple, returning it as given
	transform((v: Array<unknown>) => v as [DiskfilePath, unknown])
);

// TODO hacky, uses the serializable form of the Gro `Disknode` (which uses maps)
export const SerializableDisknode = object({
	id: DiskfilePath,
	source_dir: DiskfileDirectoryPath,
	contents: nullable(string),
	ctime: nullable(number),
	mtime: nullable(number),
	dependents: array(DisknodeEdge),
	dependencies: array(DisknodeEdge)
});
export type SerializableDisknode = Infer<typeof SerializableDisknode>;

/**
 * A disknode without its contents — what a `touch` change carries. It has no
 * `contents` key, which is not `contents: null`: `null` says the file's
 * contents aren't loaded, and this says nothing about them — whoever holds
 * the file keeps the contents it has.
 */
const { contents: _contents, ...disknode_metadata_entries } = SerializableDisknode.def;
export const DisknodeMetadata = object(disknode_metadata_entries);
export type DisknodeMetadata = Infer<typeof DisknodeMetadata>;

/**
 * A file on disk. `path` and `source_dir` are required — a diskfile is
 * always for one file. `content` is `null` when it wasn't loaded (see
 * `Diskfile.content_loaded`).
 */
export const DiskfileJson = cell_json_schema(
	{
		path: DiskfilePath,
		source_dir: DiskfileDirectoryPath,
		content: with_default(nullable(string), null),
		/**
		 * When the file was last modified on disk, in milliseconds since the
		 * epoch — `null` when the backend couldn't say. It moves whenever the
		 * file's bytes do, including for a file whose content isn't loaded.
		 */
		mtime: with_default(nullable(number), null),
		dependents: with_default_fn(SerializableDisknode.def.dependents, () => []),
		dependencies: with_default_fn(SerializableDisknode.def.dependencies, () => [])
	},
	'Diskfile'
);
export type DiskfileJson = Infer<typeof DiskfileJson>;
export type DiskfileJsonInput = InferInput<typeof DiskfileJson>;
