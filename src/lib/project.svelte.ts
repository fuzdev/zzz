import {
	array,
	literal,
	min_value,
	nullable,
	number,
	object,
	one_of,
	optional,
	pipe,
	record,
	safe_integer,
	string,
	variant,
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
 * Why a project opened as a git checkout or plain directory rather than as
 * the registry (`repos.toml`) found above the opened path: `unregistered` —
 * the path is in none of its present entries — or `registry_refused`, with
 * the daemon's `reason` (`registry_invalid`, `registry_untrusted`,
 * `registry_not_confined`, `registry_root_in_entry`, …): a registry inside
 * a checkout that couldn't be used, so the checkout opened instead.
 */
export const ProjectFallbackJson = variant('kind', [
	object({
		kind: literal('unregistered'),
		/** The registry file passed over. */
		registry_path: DiskfilePath
	}),
	object({
		kind: literal('registry_refused'),
		/** The registry file passed over. */
		registry_path: DiskfilePath,
		/** Why it was refused. */
		reason: string
	})
]);
export type ProjectFallbackJson = Infer<typeof ProjectFallbackJson>;

/**
 * A lifecycle rev: the daemon bumps it on every change to its open projects
 * and stamps it on what changed, so a client applies a project's state only
 * when it's newer than the state it holds, whatever order replies and
 * notifications arrive in. Seeded from the clock (microseconds since the
 * epoch) at boot, so revs keep increasing across restarts; below 2^53, so
 * exact as a JSON number.
 */
export const ProjectRev = pipe(number, safe_integer, min_value(0));
export type ProjectRev = Infer<typeof ProjectRev>;

/**
 * What git ignores under one focused directory on git's rule: the daemon's
 * answer, which replaces the client's fixed names there.
 */
export const ProjectIgnoredJson = object({
	/**
	 * Relative to the directory, sorted: each directory git prunes whole with
	 * a trailing `/` (the directory itself, ignored whole, as `./`), and each
	 * file it skips alone without one.
	 *
	 * The daemon sorts by Rust's byte order, which differs from JS string
	 * order (UTF-16 code units) for non-BMP characters.
	 * TODO step 5's ignore predicate must not binary-search `paths` on the
	 * daemon's order — sort it here, or look up without relying on order.
	 */
	paths: array(string),
	/**
	 * Bumped each time the daemon re-pruned the directory without sending a
	 * `filer_change` per file — too many changed at once (a `node_modules/`
	 * un-ignored) — so a client seeing it move pulls the directory's files
	 * whole (`repo_files`).
	 */
	resyncs: pipe(number, safe_integer, min_value(0))
});
export type ProjectIgnoredJson = Infer<typeof ProjectIgnoredJson>;

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
	/** The registry passed over, for a checkout or plain directory opened under one. */
	fallback: nullable(ProjectFallbackJson),
	/**
	 * The focused directories, each indexed whole, sorted. Opening a path
	 * focuses the repo holding it, and `repo_focus` / `repo_unfocus` a
	 * registry's entries one by one; a checkout's or plain directory's root is
	 * its one. A registry's root is indexed at its top level alone, so an
	 * unfocused entry has no files.
	 */
	focused: array(DiskfileDirectoryPath),
	/**
	 * What git ignores under each focused directory on git's rule, keyed by
	 * the directory. A focused directory without an entry is on fixed names
	 * (a plain directory, or git unusable), and a registry's root, indexed at
	 * its top level, never has one.
	 */
	ignored: record(ProjectIgnoredJson),
	/** The rev at which this project last changed — on a close, the close's own. */
	rev: ProjectRev
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
		fallback: with_default(nullable(ProjectFallbackJson), null),
		focused: with_default_fn(array(DiskfileDirectoryPath), () => []),
		ignored: with_default_fn(record(ProjectIgnoredJson), () => ({})),
		/**
		 * The rev of the state held (`ProjectRev`), `-1` when unknown — a
		 * project not from the daemon, or one held across a restart, which any
		 * state from the daemon replaces.
		 */
		rev: with_default(number, -1)
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
	fallback: ProjectFallbackJson | null = $state.raw()!;
	focused: Array<DiskfileDirectoryPath> = $state.raw()!;
	ignored: Record<string, ProjectIgnoredJson> = $state.raw()!;
	rev: number = $state.raw()!;

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
	): Promise<Result<{ value: Project | null }, { error: JsonrpcErrorObject }>> {
		return this.app.projects.focus_repo(this.root, dir);
	}

	/** Unfocuses `dir`, one of this registry's entries — see `Projects.unfocus_repo`. */
	unfocus_repo(
		dir: DiskfileDirectoryPath
	): Promise<Result<{ value: Project | null }, { error: JsonrpcErrorObject }>> {
		return this.app.projects.unfocus_repo(this.root, dir);
	}
}
