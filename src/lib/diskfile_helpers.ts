import { ensure_end } from '@fuzdev/fuz_util/string.ts';
import { create_uuid, Uuid } from '@fuzdev/fuz_util/id.ts';
import { Datetime, DatetimeNow } from '@fuzdev/fuz_util/datetime.ts';

import { SerializableDisknode, type DiskfileJson } from './diskfile_types.ts';
import type { Diskfile } from './diskfile.svelte.ts';

/**
 * Why a diskfile's content can be missing: the backend indexes a file's
 * content only when it's a UTF-8 text file of at most 4 MiB that it could
 * read, and sends `contents: null` otherwise.
 */
export const DISKFILE_CONTENT_NOT_LOADED_MESSAGE =
	'content not loaded — the file is over 4 MiB, not UTF-8 text, or unreadable';

/** `data.reason` of the error refusing to write over a file whose content wasn't loaded. */
export const ERROR_CONTENT_NOT_LOADED = 'content_not_loaded';

/**
 * Stands in for a file part's content in a formatted prompt when the file's
 * content wasn't loaded, so the omission is visible — to the user in the
 * preview and copied text, and to a model — instead of the file silently
 * dropping out.
 */
export const DISKFILE_CONTENT_NOT_LOADED_PLACEHOLDER = `[${DISKFILE_CONTENT_NOT_LOADED_MESSAGE}]`;

// TODO probably extract to `@fuzdev/fuz_util/path.ts`
export const is_path_absolute = (path: string): boolean => path[0] === '/';

/**
 * Formats `path` for display relative to the directory `parent`: the part
 * after `parent` when `path` is inside it, else `path` unchanged, so a path
 * outside `parent` stays absolute rather than losing its leading `/`.
 *
 * @param path - the absolute path to format
 * @param parent - the directory to show `path` relative to, with or without a trailing `/`
 * @returns `path` relative to `parent` if it's inside it, else `path`
 */
export const to_relative_path = (path: string, parent: string): string => {
	if (!parent) return path;
	const dir = ensure_end(parent, '/');
	return path.length > dir.length && path.startsWith(dir) ? path.slice(dir.length) : path;
};

// TODO @many refactor source/disk files with Gro Disknode too
/**
 * Converts a `SerializableDisknode` to the `DiskfileJson` format.
 * @param disknode - the source file to convert
 * @param existing_id - optional existing `Uuid` to preserve id stability across updates
 */
export const disknode_to_diskfile_json = (
	disknode: SerializableDisknode,
	existing_id: Uuid = create_uuid()
): DiskfileJson => {
	const created = DatetimeNow.parse(
		disknode.ctime == null ? undefined : new Date(disknode.ctime).toISOString()
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
		dependencies: disknode.dependencies
	};
};

// TODO hacky
export const SUPPORTED_CODE_FILETYPE_MATCHER = /\.[mc]?[jt]sx?$/i;
export const has_dependencies = (diskfile: Diskfile): boolean =>
	diskfile.dependencies_count > 0 ||
	diskfile.dependents_count > 0 ||
	SUPPORTED_CODE_FILETYPE_MATCHER.test(diskfile.path);
