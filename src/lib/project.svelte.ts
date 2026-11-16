import {
	array,
	nullable,
	object,
	one_of,
	optional,
	string,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { Timestamp } from '@fuzdev/fuz_app/primitive_schemas.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';

import { type Datetime } from './datetime.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import { DiskfileDirectoryPath, DiskfilePath } from './diskfile_types.ts';

/**
 * Which rule rooted a project: a registry (`repos.toml`) at its root, the
 * git checkout holding the opened path, or the opened directory itself.
 */
export const ProjectKind = one_of(['registry', 'git_repo', 'plain_dir']);
export type ProjectKind = Infer<typeof ProjectKind>;

/**
 * Where a registry entry's checkout stands: `present` at its `dir`,
 * `missing` (not yet cloned), or `refused` alone — it escapes the root, is
 * protected, can't be resolved, or isn't a directory — while the rest of the
 * project stands.
 */
export const ProjectEntryState = one_of(['present', 'missing', 'refused']);
export type ProjectEntryState = Infer<typeof ProjectEntryState>;

/** A registry entry of an open project, as the daemon resolved it. */
export const ProjectEntryJson = object({
	/** The entry's key in its table. */
	key: string,
	/** Which table: an owned repo, or a reference checkout. */
	kind: one_of(['repo', 'reference']),
	/** Where its checkout is: canonical when present, else the declared dir under the root. */
	dir: DiskfileDirectoryPath,
	state: ProjectEntryState,
	/** Why it's refused (`entry_not_confined`, `entry_unresolvable`, …), for a refused entry. */
	reason: optional(string)
});
export type ProjectEntryJson = Infer<typeof ProjectEntryJson>;

/**
 * The wire format of an open project, shared between frontend and backend —
 * in action spec inputs and outputs, and the `Project` cell's JSON.
 */
export const ProjectInfoJson = object({
	/** The project's root, canonical — its identity. */
	root: DiskfileDirectoryPath,
	/** The root's basename. */
	name: string,
	/** UTC ISO timestamp of when the project was first opened. */
	opened_at: Timestamp,
	kind: ProjectKind,
	/** The registry file as found at the root, for a registry project. */
	registry_path: nullable(DiskfilePath),
	/** A registry's entries in its order; empty for other kinds. */
	entries: array(ProjectEntryJson),
	/**
	 * The focused directories, each indexed whole, sorted. Opening a path
	 * focuses the repo holding it, and `repo_focus` / `repo_unfocus` a
	 * registry's entries one by one; a checkout's or plain directory's root is
	 * its one. A registry's root is indexed at its top level alone, so an
	 * unfocused entry has no files.
	 */
	focused: array(DiskfileDirectoryPath)
});
export type ProjectInfoJson = Infer<typeof ProjectInfoJson>;

/**
 * Whether every indexed directory of an open project has a file watch.
 * `degraded` means the OS ran out of watches (inotify's `max_user_watches`),
 * no watcher could be created, or a directory went missing: the directories
 * without a watch are rescanned every few seconds, so their changes show up
 * late.
 */
export const ProjectWatchStatus = one_of(['full', 'degraded']);
export type ProjectWatchStatus = Infer<typeof ProjectWatchStatus>;

export const ProjectJson = cell_json_schema(
	{
		root: DiskfileDirectoryPath,
		name: with_default(string, ''),
		opened_at: with_default(string, ''),
		kind: with_default(ProjectKind, 'plain_dir'),
		registry_path: with_default(nullable(DiskfilePath), null),
		entries: with_default_fn(array(ProjectEntryJson), () => []),
		focused: with_default_fn(array(DiskfileDirectoryPath), () => [])
	},
	'Project'
);
export type ProjectJson = Infer<typeof ProjectJson>;
export type ProjectJsonInput = InferInput<typeof ProjectJson>;

export interface ProjectOptions extends CellOptions<typeof ProjectJson> {}

/**
 * An open project: a root directory the daemon serves — one scoped root —
 * and the directories in it that are focused, which its file index covers.
 * Keyed by `root`. Focus is the daemon's, shared by every client, and lasts
 * until it's unfocused (`unfocus_repo`, a registry's entries only) or the
 * project closes.
 */
export class Project extends Cell<typeof ProjectJson> {
	root: DiskfileDirectoryPath = $state.raw()!;
	name: string = $state.raw()!;
	opened_at: Datetime = $state.raw()!;
	kind: ProjectKind = $state.raw()!;
	registry_path: DiskfilePath | null = $state.raw()!;
	entries: Array<ProjectEntryJson> = $state.raw()!;
	focused: Array<DiskfileDirectoryPath> = $state.raw()!;

	/**
	 * Whether the daemon watches every indexed directory of this project, as
	 * of the last `project_open` — `degraded` means some are only rescanned
	 * periodically. Transient client state, not serialized.
	 */
	watch_status: ProjectWatchStatus = $state.raw('full');

	/**
	 * The directory this client's last open of the project focused, or
	 * `null` — where new files go by default (`Diskfiles.new_files_dir`).
	 * Transient client state, not serialized.
	 */
	last_focus: DiskfileDirectoryPath | null = $state.raw(null);

	/**
	 * Where new files and folders go: the last open's focus while it's still
	 * focused, else the root.
	 */
	readonly new_files_dir: DiskfileDirectoryPath = $derived(
		this.last_focus !== null && this.focused.includes(this.last_focus) ? this.last_focus : this.root
	);

	/**
	 * What a reopen restores after a daemon restart: each focused directory,
	 * requested as the focus of an open of the root, or the root alone when
	 * none is.
	 */
	readonly reopen_paths: Array<DiskfileDirectoryPath> = $derived(
		this.focused.length ? this.focused : [this.root]
	);

	constructor(options: ProjectOptions) {
		super(ProjectJson, options);
		this.init();
	}

	/** Focuses `dir`, one of this registry's present entries — see `Projects.focus_repo`. */
	focus_repo(
		dir: DiskfileDirectoryPath
	): Promise<Result<{ value: Project }, { error: JsonrpcErrorObject }>> {
		return this.app.projects.focus_repo(this.root, dir);
	}

	/** Unfocuses `dir`, one of this registry's entries — see `Projects.unfocus_repo`. */
	unfocus_repo(
		dir: DiskfileDirectoryPath
	): Promise<Result<{ value: Project }, { error: JsonrpcErrorObject }>> {
		return this.app.projects.unfocus_repo(this.root, dir);
	}
}
