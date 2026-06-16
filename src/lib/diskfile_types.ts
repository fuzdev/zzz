import {z} from 'zod';

import {CellJson} from './cell_types.ts';
import {is_path_absolute} from './diskfile_helpers.ts';
import {PathWithTrailingSlash} from './zod_helpers.ts';

export const DiskfileChangeType = z.enum(['add', 'change', 'delete']);
export type DiskfileChangeType = z.infer<typeof DiskfileChangeType>;

/** An absolute Unix-style file path. */
export const DiskfilePath = z
	.string()
	.refine((p) => is_path_absolute(p), {message: 'path must be absolute'})
	.brand('DiskfilePath');
export type DiskfilePath = z.infer<typeof DiskfilePath>;

/** These always have a trailing slash. */
export const DiskfileDirectoryPath =
	PathWithTrailingSlash.pipe(DiskfilePath).brand('DiskfileDirectoryPath');
export type DiskfileDirectoryPath = z.infer<typeof DiskfileDirectoryPath>;

export const DiskfileChange = z.strictObject({
	type: DiskfileChangeType,
	path: DiskfilePath,
});
export type DiskfileChange = z.infer<typeof DiskfileChange>;

// TODO hacky, uses the serializable form of the Gro `Disknode` (which uses maps)
export const SerializableDisknode = z.strictObject({
	id: DiskfilePath,
	source_dir: DiskfileDirectoryPath,
	contents: z.string().nullable(),
	ctime: z.number().nullable(),
	mtime: z.number().nullable(),
	dependents: z.array(z.tuple([DiskfilePath, z.any()])), // TODO @many zod4 - these can't be circular refs, how to rewrite?
	dependencies: z.array(z.tuple([DiskfilePath, z.any()])), // TODO @many zod4 - these can't be circular refs, how to rewrite?
});
export type SerializableDisknode = z.infer<typeof SerializableDisknode>;

// Directly extend the base schema with Diskfile-specific properties
export const DiskfileJson = CellJson.extend({
	path: DiskfilePath.nullable().default(null),
	source_dir: DiskfileDirectoryPath,
	content: z.string().nullable().default(null),
	dependents: z
		.array(z.tuple([DiskfilePath, SerializableDisknode]))
		.nullable()
		.default(null),
	dependencies: z
		.array(z.tuple([DiskfilePath, SerializableDisknode]))
		.nullable()
		.default(null),
}).meta({cell_class_name: 'Diskfile'});
export type DiskfileJson = z.infer<typeof DiskfileJson>;
export type DiskfileJsonInput = z.input<typeof DiskfileJson>;
