import { ensure_end } from '@fuzdev/fuz_util/string.ts';
import { create_uuid, Uuid } from '@fuzdev/fuz_util/id.ts';
import { Datetime, DatetimeNow } from '@fuzdev/fuz_util/datetime.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';

import { SerializableDisknode, type DiskfileJson } from './diskfile_types.ts';
import type { Diskfile } from './diskfile.svelte.ts';
import type { Diskfiles } from './diskfiles.svelte.ts';

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
 * Normalizes an absolute path the way the backend's `ScopedFs` does before
 * touching the filesystem, without filesystem access: drops empty and `.`
 * segments and any trailing `/`, and resolves `..` against the preceding
 * segment (never above `/`). The filer reports paths in this form.
 *
 * @param path - an absolute path
 * @returns the normalized path, `/` for the root
 */
export const normalize_path = (path: string): string => {
	const segments: Array<string> = [];
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return '/' + segments.join('/');
};

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

/**
 * The directories holding the file at `path`, each with a trailing `/`:
 * every ancestor from its parent up to its root `source_dir`, inclusive,
 * innermost first — none when `path` isn't under `source_dir`. The file
 * index lists only files, so a folder exists for it exactly when it holds one.
 *
 * @param path - an indexed file's path
 * @param source_dir - the root it's indexed under, with a trailing `/`
 */
export const to_file_directories = (path: string, source_dir: string): Array<string> => {
	const dirs: Array<string> = [];
	if (!path.startsWith(source_dir)) return dirs;
	let end = path.lastIndexOf('/');
	while (end >= source_dir.length - 1) {
		dirs.push(path.slice(0, end + 1));
		// `lastIndexOf` clamps a negative start to 0, which would find the root's `/` forever
		end = end === 0 ? -1 : path.lastIndexOf('/', end - 1);
	}
	return dirs;
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
		mtime: disknode.mtime,
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

/**
 * Parses a name entered for a new file or folder, a path relative to
 * `Diskfiles.new_files_dir` (`sub/name.ts` creates any missing folders).
 * Leading whitespace and slashes are dropped, as is trailing whitespace —
 * like a pasted name's stray space or newline, they're almost never meant.
 * Whitespace inside the name is kept, including around an inner `/`. Empty,
 * `.`, and `..` segments are left for the backend to normalize
 * (`sub/../a.txt` creates `a.txt`). Refused: a blank or whitespace-only name;
 * one that normalizes to the directory itself (`sub/..`); a whitespace-only
 * segment (it would create a folder named by whitespace); a `..` that climbs
 * out of the directory; and for a file, a last segment that's empty, `.`, or
 * `..` (`x/`, `x/.`, `x/y/..`), which names a folder, not a file.
 *
 * @param name - the entered name
 * @param kind - whether the name is for a file or a folder
 * @returns the name to create, or a message saying why it's refused
 */
export const parse_new_diskfile_name = (
	name: string,
	kind: 'file' | 'folder'
): Result<{ value: string }, { message: string }> => {
	let value = name;
	for (let previous = ''; value !== previous;) {
		previous = value;
		value = value.trim().replace(/^\/+/, '');
	}
	if (!value) return { ok: false, message: `${kind} name must not be blank` };
	const segments = value.split('/');
	if (kind === 'file') {
		const last = segments.at(-1);
		if (last === '' || last === '.' || last === '..') {
			return {
				ok: false,
				message: `file name must end with a file name, not ${last ? `"${last}"` : '"/"'}`
			};
		}
	}
	let depth = 0;
	for (const segment of segments) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (--depth < 0) {
				return {
					ok: false,
					message: `${kind} name must stay inside the directory`
				};
			}
			continue;
		}
		if (!segment.trim()) {
			return {
				ok: false,
				message: `${kind} name has a whitespace-only segment`
			};
		}
		depth++;
	}
	if (depth === 0) {
		return { ok: false, message: `${kind} name names the directory itself` };
	}
	return { ok: true, value };
};

// TODO improve UX to not use alert/prompt
/**
 * Asks for a name and creates a file or folder of that name in
 * `Diskfiles.new_files_dir` (see `Diskfiles.create_file` and
 * `Diskfiles.create_directory`), alerting on failure — including a name
 * `parse_new_diskfile_name` refuses, such as a whitespace-only one — with
 * the name first (`couldn't create file a.txt: <reason>`). A backend failure
 * is already logged by its action handler. Cancelling or entering an empty
 * name does nothing.
 *
 * @param diskfiles - the diskfiles to create in
 * @param kind - whether to create a file or a folder
 */
export const prompt_create_diskfile = async (
	diskfiles: Diskfiles,
	kind: 'file' | 'folder'
): Promise<void> => {
	const name = prompt(`new ${kind} name in ${diskfiles.new_files_dir}:`); // eslint-disable-line no-alert
	if (!name) return;

	try {
		await (kind === 'file' ? diskfiles.create_file(name) : diskfiles.create_directory(name));
	} catch (error) {
		const display_name = name.trim() || JSON.stringify(name);
		alert(`couldn't create ${kind} ${display_name}: ${to_error_message(error)}`); // eslint-disable-line no-alert
	}
};

/**
 * Deletes `diskfile` on disk (see `Diskfiles.delete`), alerting on failure
 * with its path first (`couldn't delete a.txt: <backend message>`), like
 * `prompt_create_diskfile`. The failure is already logged by the action handler.
 *
 * @param diskfiles - the diskfiles to delete from
 * @param diskfile - the file to delete
 * @returns whether the file was deleted
 */
export const delete_diskfile = async (
	diskfiles: Diskfiles,
	diskfile: Diskfile
): Promise<boolean> => {
	try {
		await diskfiles.delete(diskfile.path);
		return true;
	} catch (error) {
		const display_path = diskfile.path_relative || diskfile.path;
		alert(`couldn't delete ${display_path}: ${to_error_message(error)}`); // eslint-disable-line no-alert
		return false;
	}
};

/**
 * Handles `beforeunload`: while any file has unsaved changes
 * (`Diskfiles.has_unsaved_changes`), asks the browser to confirm leaving the
 * page, since drafts live only in memory.
 *
 * @param event - the `beforeunload` event
 * @param diskfiles - the app's diskfiles, if there's an app
 * @mutates event - cancels it (`preventDefault` plus the legacy `returnValue`) to ask for confirmation
 */
export const confirm_unload_with_unsaved_changes = (
	event: BeforeUnloadEvent,
	diskfiles: Diskfiles | undefined
): void => {
	if (!diskfiles?.has_unsaved_changes) return;
	event.preventDefault();
	// older browsers need a set `returnValue` to show the prompt
	event.returnValue = ''; // eslint-disable-line @typescript-eslint/no-deprecated
};
