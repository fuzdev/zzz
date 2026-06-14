import {strip_start} from '@fuzdev/fuz_util/string.js';
import {create_uuid, Uuid} from '@fuzdev/fuz_util/id.js';
import {Datetime, DatetimeNow} from '@fuzdev/fuz_util/datetime.js';

import {SerializableDisknode, type DiskfileJson} from './diskfile_types.js';
import type {Diskfile} from './diskfile.svelte.js';

// TODO probably extract to `@fuzdev/fuz_util/path.js`
export const is_path_absolute = (path: string): boolean => path[0] === '/';

// TODO hacky, refactor path helpers with `@fuzdev/fuz_util/path.js`
export const to_relative_path = (path: string, parent: string): string =>
	strip_start(strip_start(path, parent), '/');

// TODO @many refactor source/disk files with Gro Disknode too
/**
 * Converts a `SerializableDisknode` to the `DiskfileJson` format.
 * @param disknode - the source file to convert
 * @param existing_id - optional existing `Uuid` to preserve id stability across updates
 */
export const disknode_to_diskfile_json = (
	disknode: SerializableDisknode,
	existing_id: Uuid = create_uuid(),
): DiskfileJson => {
	const created = DatetimeNow.parse(
		disknode.ctime == null ? undefined : new Date(disknode.ctime).toISOString(),
	);
	return {
		id: existing_id,
		source_dir: disknode.source_dir,
		path: disknode.id, // notice the Disknode `id` is a path
		content: disknode.contents, // notice `contents` -> `content`
		created,
		updated:
			disknode.mtime == null ? created : Datetime.parse(new Date(disknode.mtime).toISOString()),
		dependents: disknode.dependents,
		dependencies: disknode.dependencies,
	};
};

// TODO hacky
export const SUPPORTED_CODE_FILETYPE_MATCHER = /\.[mc]?[jt]sx?$/i;
export const has_dependencies = (diskfile: Diskfile): boolean =>
	diskfile.dependencies_count > 0 ||
	diskfile.dependents_count > 0 ||
	SUPPORTED_CODE_FILETYPE_MATCHER.test(diskfile.path);
