import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { ensure_end } from '@fuzdev/fuz_util/string.ts';
import { create_uuid, type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';

import { Datetime, DatetimeNow } from './datetime.ts';
import {
	SerializableDisknode,
	type DiskfileJson,
	type DiskfilePath,
	type SnapshotFiles
} from './diskfile_types.ts';
import type { Diskfile } from './diskfile.svelte.ts';
import type { Diskfiles } from './diskfiles.svelte.ts';

/**
 * Why a diskfile's content can be missing: it loads only when it's a UTF-8
 * text file of at most 4 MiB that the backend could read. Said when the
 * reason isn't known — `to_diskfile_unloaded_message` is more specific when
 * it is.
 */
export const DISKFILE_CONTENT_NOT_LOADED_MESSAGE =
	'content not loaded — the file is over 4 MiB, not UTF-8 text, or unreadable';

/** Said while a diskfile's content is on its way (`content_status` `unrequested` or `loading`). */
export const DISKFILE_CONTENT_LOADING_MESSAGE = 'loading the content';

/**
 * What to say about a diskfile's missing content: that it's loading, or why
 * it can't load — the reason or error its read gave, when there was one.
 *
 * @returns the message, `null` when the content is loaded
 */
export const to_diskfile_unloaded_message = (
	diskfile: Pick<Diskfile, 'content_status' | 'unloaded_reason' | 'content_error'>
): string | null => {
	switch (diskfile.content_status) {
		case 'loaded':
			return null;
		case 'unrequested':
		case 'loading':
			return DISKFILE_CONTENT_LOADING_MESSAGE;
		case 'unloadable':
			if (diskfile.unloaded_reason === 'too_large') {
				return 'content not loaded — the file is over 4 MiB';
			}
			if (diskfile.unloaded_reason === 'not_utf8') {
				return "content not loaded — the file isn't UTF-8 text";
			}
			if (diskfile.content_error !== null) {
				return `content not loaded — ${diskfile.content_error}`;
			}
			return DISKFILE_CONTENT_NOT_LOADED_MESSAGE;
	}
};

/**
 * `data.reason` of the `invalid_params` refusing a path that isn't absolute
 * (or holds a NUL byte) — twin of `ERROR_INVALID_PATH` in the backend's
 * filesystem handlers.
 */
export const ERROR_INVALID_PATH = 'invalid_path';

/**
 * `data.reason` of a file action's error for a path that doesn't exist —
 * twin of `ERROR_PATH_NOT_FOUND` in the backend's filesystem handlers.
 */
export const ERROR_PATH_NOT_FOUND = 'path_not_found';

/** `data.reason` of the error refusing to write over a file whose content wasn't loaded. */
export const ERROR_CONTENT_NOT_LOADED = 'content_not_loaded';

/**
 * `data.reason` of the `conflict` a save based on content the file no longer
 * holds gets (`diskfile_update`'s `expected_hash`) — twin of
 * `ERROR_DISK_CHANGED` in the backend's filesystem handlers.
 */
export const ERROR_DISK_CHANGED = 'disk_changed';

/**
 * Stands in for a file part's content in a formatted prompt while the file's
 * content is loading — what a preview shows until it arrives. Sending or
 * copying awaits the content instead (`load_parts_content`), so neither
 * carries this.
 */
export const DISKFILE_CONTENT_LOADING_PLACEHOLDER = `[${DISKFILE_CONTENT_LOADING_MESSAGE}]`;

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
 * The innermost of `roots` holding `path` below it — the root the file tree
 * shows `path` under (`DiskfileTreeState.reveal`), and the one a copied
 * relative path is relative to. A root isn't below itself, so a root's own
 * path finds only a root around it.
 *
 * @param path - a file's path, or a folder's with a trailing `/`
 * @param roots - the indexed roots, each with a trailing `/`
 * @returns the innermost root holding `path`, `null` when none does
 */
export const to_innermost_root = (path: string, roots: ReadonlyArray<string>): string | null => {
	let found: string | null = null;
	for (const root of roots) {
		if (path.length > root.length && path.startsWith(root)) {
			if (!found || root.length > found.length) found = root;
		}
	}
	return found;
};

/** What a contextmenu copies for a file or folder — see `to_diskfile_copy_paths`. */
export interface DiskfileCopyPaths {
	/** The absolute path, without a folder's trailing `/`. */
	absolute: string;
	/** Relative to the innermost root holding it (`to_innermost_root`), `null` under none. */
	relative: string | null;
	/** The last segment. */
	name: string;
}

/**
 * The paths a file's or folder's contextmenu copies. A folder's are written
 * without its trailing `/`, as a shell or another editor takes them. Relative
 * paths go from the innermost root, whichever root the row is shown under, so
 * a file copies the same relative path from the list, a tab, or either of two
 * overlapping roots.
 *
 * @param path - a file's path, or a folder's with a trailing `/`
 * @param roots - the indexed roots, each with a trailing `/`
 */
export const to_diskfile_copy_paths = (
	path: string,
	roots: ReadonlyArray<string>
): DiskfileCopyPaths => {
	const absolute = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
	const root = to_innermost_root(path, roots);
	return {
		absolute,
		relative: root && absolute.slice(root.length),
		name: absolute.slice(absolute.lastIndexOf('/') + 1)
	};
};

/**
 * Names the file index never enters or lists under any root, on either rule
 * (`FileIndexIgnoreRule`) — a folder's or a file's: the backend filer's
 * `ALWAYS_IGNORED_DIRS` in `crates/zzz_server/src/filer/ignore.rs` and the
 * credential directories it skips too (`CREDENTIAL_DIR_NAMES` in
 * `crates/zzz_server/src/scoped_fs.rs`), which a test holds this to. Not even
 * a `.gitignore` can let the index into these.
 */
export const FILE_INDEX_ALWAYS_IGNORED_NAMES: ReadonlySet<string> = new Set([
	'.git',
	'.zzz',
	'.ssh',
	'.gnupg',
	'.aws',
	'.kube',
	'.docker',
	'.password-store'
]);

/**
 * Names the file index skips besides `FILE_INDEX_ALWAYS_IGNORED_NAMES` under
 * a root on fixed names only — the build and dependency output that would
 * swamp it (`PLAIN_DIR_IGNORED_DIRS` in `crates/zzz_server/src/filer/ignore.rs`,
 * which a test holds this to). Under a git root git decides these instead,
 * so a tracked `dist/` is indexed there.
 */
export const FILE_INDEX_PLAIN_DIR_IGNORED_NAMES: ReadonlySet<string> = new Set([
	'node_modules',
	'.svelte-kit',
	'target',
	'dist'
]);

/**
 * The prefix of the backend's staging files, which the index never lists
 * (`TEMP_FILE_PREFIX` in `crates/zzz_server/src/scoped_fs.rs`, which a test
 * holds this to).
 */
export const FILE_INDEX_TEMP_FILE_PREFIX = '.zzz-tmp-';

/**
 * How the file index decides what it skips under one root — the client's
 * view of the backend filer's `IgnoreRule`:
 *
 * - `fixed` — by name alone, `FILE_INDEX_ALWAYS_IGNORED_NAMES` and
 *   `FILE_INDEX_PLAIN_DIR_IGNORED_NAMES` wherever they appear: a plain
 *   directory, a registry's root (indexed at its top level), the app
 *   directory and the scoped dirs while no open project focuses them, and a
 *   focused directory whose project state has no `ignored` entry
 * - `git` — `FILE_INDEX_ALWAYS_IGNORED_NAMES` by name; `paths`, the
 *   daemon's `ProjectIgnoredJson.paths` for that root: relative to it, each
 *   ignored directory with a trailing `/` (the root itself as `./`), each
 *   ignored file without one; and `nested`, its `ProjectIgnoredJson.nested`:
 *   the directories holding a repo of their own, which the filer doesn't
 *   enter, relative, each with a trailing `/`
 *
 * A permanent filer on a git checkout (the app dir or a scoped dir) runs
 * git's rule on the daemon, but its paths aren't on the wire unless a
 * project focuses it, so here it reads as `fixed`: a tracked `dist/` in it
 * is indexed but hidden in the tree, and a file git ignores there reads as
 * broken in a link, and is waited for, without a notice, when created.
 */
export type FileIndexIgnoreRule =
	{ kind: 'fixed' } | { kind: 'git'; paths: ReadonlySet<string>; nested: ReadonlySet<string> };

/** The rule of every root without git's answer — see `FileIndexIgnoreRule`. */
export const FILE_INDEX_FIXED_NAMES_RULE: FileIndexIgnoreRule = { kind: 'fixed' };

/**
 * The part of a path the file index skips — see `to_unindexed_part`:
 *
 * - `by` — `name` for an ignored name (`FILE_INDEX_ALWAYS_IGNORED_NAMES`, a
 *   staging file's prefix, or under fixed names
 *   `FILE_INDEX_PLAIN_DIR_IGNORED_NAMES`), `git` for a path git ignores,
 *   `nested` for a folder holding a repo of its own under a git root
 * - `path` — the skipped part, absolute: a folder with a trailing `/` (the
 *   root itself when git ignores it whole), a file without one
 */
export interface FileIndexUnindexedPart {
	by: 'name' | 'git' | 'nested';
	path: string;
}

/**
 * Whether the file index skips any path part named `name` under every rule:
 * an always-ignored name or a staging file's.
 */
export const is_file_index_always_ignored_name = (name: string): boolean =>
	FILE_INDEX_ALWAYS_IGNORED_NAMES.has(name) || name.startsWith(FILE_INDEX_TEMP_FILE_PREFIX);

/**
 * The first part of `path` below `root` that the file index skips under
 * `rule` — the backend filer's `is_ignored` for one root, and the one
 * predicate the file tree, markdown links, and creating a file share. The
 * filer never lists such a path from `root`, so a link there can't be told
 * broken, and a file or folder created there never shows.
 *
 * Checks each part from the root down: a name ignored under every rule, a
 * name ignored under fixed names, or under git each folder prefix (`a/`,
 * `a/b/`, …) and the path itself in `rule.paths`, then each folder prefix in
 * `rule.nested` — the order the filer's walk checks them in. Set lookups,
 * O(depth), never relying on the daemon's sort order. A file entry matches
 * only a file path and a folder entry only a folder, as the filer keeps them
 * apart.
 *
 * @param path - a normalized file path, or a folder's with a trailing `/`
 * @param root - the root whose filer would list it, with a trailing `/`
 * @param rule - that root's rule
 * @returns the skipped part, `null` when the index enters it all or `path`
 * isn't under `root`
 */
export const to_unindexed_part = (
	path: string,
	root: string,
	rule: FileIndexIgnoreRule
): FileIndexUnindexedPart | null => {
	if (!path.startsWith(root)) return null;
	const git_paths = rule.kind === 'git' ? rule.paths : null;
	const nested = rule.kind === 'git' ? rule.nested : null;
	if (git_paths?.has('./')) return { by: 'git', path: root };
	const rest = path.slice(root.length);
	let start = 0;
	while (start < rest.length) {
		const slash = rest.indexOf('/', start);
		const end = slash === -1 ? rest.length : slash + 1;
		const name = rest.slice(start, slash === -1 ? rest.length : slash);
		if (
			is_file_index_always_ignored_name(name) ||
			(!git_paths && FILE_INDEX_PLAIN_DIR_IGNORED_NAMES.has(name))
		) {
			return { by: 'name', path: root + rest.slice(0, end) };
		}
		const part = rest.slice(0, end);
		if (git_paths?.has(part)) return { by: 'git', path: root + part };
		if (nested?.has(part)) return { by: 'nested', path: root + part };
		start = end;
	}
	return null;
};

/**
 * Says why the file index skips `part`, short: the name it skips everywhere,
 * the path git ignores, or the folder that's a repo of its own — a path
 * relative to `root` when below it.
 *
 * @param part - what `to_unindexed_part` found
 * @param root - the root the path is shown under, with a trailing `/`
 */
export const to_unindexed_reason = (part: FileIndexUnindexedPart, root: string): string => {
	if (part.by === 'git') return `git ignores "${to_relative_path(part.path, root)}"`;
	if (part.by === 'nested') return `"${to_relative_path(part.path, root)}" is a repo of its own`;
	const path = part.path.endsWith('/') ? part.path.slice(0, -1) : part.path;
	return `the file index skips "${path.slice(path.lastIndexOf('/') + 1)}"`;
};

/**
 * Like `to_unindexed_part`, over every filer that would hold `path`: the
 * daemon indexes the union of its filers, so a path is skipped only when
 * each root holding it below itself skips it — a whole tree in `trees`, or
 * in `top_levels` one listing only its direct children. The part returned
 * is the innermost such root's.
 *
 * @param path - a normalized file path, or a folder's with a trailing `/`
 * @param trees - the roots whose filers index their whole trees, each with a trailing `/`
 * @param top_levels - the roots whose filers index their top level alone, each with a trailing `/`
 * @param rules - the roots on git's rule, by root; any other is on fixed names
 * @returns the innermost root's skipped part, `null` when some filer holding
 * `path` indexes it or none holds it
 */
export const to_innermost_unindexed_part = (
	path: string,
	trees: ReadonlyArray<string>,
	top_levels: ReadonlyArray<string>,
	rules: ReadonlyMap<string, FileIndexIgnoreRule>
): FileIndexUnindexedPart | null => {
	let found: FileIndexUnindexedPart | null = null;
	let found_root = '';
	for (const root of [...trees, ...top_levels]) {
		if (path.length <= root.length || !path.startsWith(root)) continue;
		// a top-level filer lists only the root's own children
		const slash = path.indexOf('/', root.length);
		if (!trees.includes(root) && slash !== -1 && slash !== path.length - 1) continue;
		const part = to_unindexed_part(path, root, rules.get(root) ?? FILE_INDEX_FIXED_NAMES_RULE);
		// some filer holding the path indexes it
		if (part === null) return null;
		if (root.length > found_root.length) {
			found = part;
			found_root = root;
		}
	}
	return found;
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
	const created = parse_or_throw(
		DatetimeNow,
		disknode.ctime == null ? undefined : new Date(disknode.ctime).toISOString()
	);
	return {
		id: existing_id,
		source_dir: disknode.source_dir,
		path: disknode.id, // notice the Disknode `id` is a path
		content: null, // a disknode is metadata only — `Diskfiles` loads the content on demand
		size: disknode.size,
		mtime: disknode.mtime,
		created,
		updated:
			disknode.mtime == null
				? created
				: parse_or_throw(Datetime, new Date(disknode.mtime).toISOString())
	};
};

/**
 * Decodes a snapshot reply's files (`SnapshotFiles`) into the disknodes
 * `Diskfiles.reconcile` and `add_initial` take: each file's `id` is its
 * group's `dir` plus its relative path, its `source_dir` the `dir`, and its
 * `ctime` its `mtime` where the tuple leaves it off.
 */
export const decode_snapshot_files = (groups: SnapshotFiles): Array<SerializableDisknode> => {
	const disknodes: Array<SerializableDisknode> = [];
	for (const { dir, files } of groups) {
		for (const file of files) {
			const mtime = file[2];
			disknodes.push({
				id: (dir + file[0]) as DiskfilePath,
				source_dir: dir,
				size: file[1],
				ctime: file.length === 4 ? file[3] : mtime,
				mtime
			});
		}
	}
	return disknodes;
};

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

/** What a file row marks beside the file's name — see `DiskfileStatusLabel`. */
export interface DiskfileStatus {
	/** Gone from disk, kept for its draft (`Diskfile.deleted_on_disk`). */
	deleted: boolean;
	/** Unsaved changes (`DiskfileEditorState.dirty`). */
	dirty: boolean;
	/** Unsaved changes, and the file changed on disk since (`DiskfileEditorState.has_conflict`). */
	conflict: boolean;
}

/**
 * The status a file row marks. Only looks the editing state up — a file never
 * opened has none, and listing a file mustn't create one.
 */
export const to_diskfile_status = (diskfiles: Diskfiles, diskfile: Diskfile): DiskfileStatus => {
	const editor_state = diskfiles.find_editor_state(diskfile.id);
	return {
		deleted: diskfile.deleted_on_disk,
		dirty: editor_state?.dirty ?? false,
		conflict: editor_state?.has_conflict ?? false
	};
};

/**
 * A file row's accessible name: `label`, then in words what its markers show,
 * since they're hidden from assistive tech.
 */
export const to_diskfile_status_label = (
	label: string | null | undefined,
	status: DiskfileStatus
): string | undefined =>
	[
		label,
		status.deleted && 'deleted on disk',
		status.conflict ? 'unsaved changes, changed on disk' : status.dirty && 'unsaved changes'
	]
		.filter(Boolean)
		.join(', ') || undefined;
