import {
	array,
	nullable,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { SvelteSet } from 'svelte/reactivity';
import { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import { create_collection_decoder } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { create_single_index } from './indexed_collection_helpers.svelte.ts';
import {
	Project,
	ProjectJson,
	type ProjectIgnoredJson,
	type ProjectInfoJson,
	type ProjectJsonInput
} from './project.svelte.ts';
import type { DiskfileDirectoryPath, DiskfilePath } from './diskfile_types.ts';
import type { ProjectFocusRefusal } from './action_specs.ts';
import { ERROR_PROJECT_NOT_OPEN, ERROR_REPO_NOT_FOCUSED } from './project_helpers.ts';

export const ProjectsJson = cell_json_schema(
	{
		items: with_default_fn(array(ProjectJson), () => []),
		active_id: with_default(nullable(Uuid), null)
	},
	'Projects'
);
export type ProjectsJson = Infer<typeof ProjectsJson>;
export type ProjectsJsonInput = InferInput<typeof ProjectsJson>;

export interface ProjectsOptions extends CellOptions<typeof ProjectsJson> {}

/**
 * What `Projects.open` returns: the project, the directory the open focused,
 * whether the open created it, and the requested focuses that didn't land.
 */
export interface ProjectOpened {
	/**
	 * The project as held here once the reply is applied, or `null` when it
	 * isn't held — closed after the open landed, a close this client applied
	 * first.
	 */
	project: Project | null;
	/** The directory the open focused, or `null` — a registry's root, or a directory in no entry. */
	focus: DiskfileDirectoryPath | null;
	/** Whether the open created the project on the daemon, rather than merging into one already open. */
	opened: boolean;
	/**
	 * The rev of the reply's state — older than `project.rev` when a newer
	 * change was applied here first.
	 */
	rev: number;
	/** Each of `options.focus` that didn't land, with the daemon's reason. */
	refused: Array<ProjectFocusRefusal>;
}

/** What `Projects.reconcile` found of the held projects against a session snapshot. */
export interface ProjectsReconciled {
	/**
	 * Roots of held projects the snapshot doesn't list and that are no newer
	 * than it — closed on the daemon, or lost to a restart. Removed unless
	 * kept.
	 */
	unlisted: Array<DiskfileDirectoryPath>;
	/**
	 * Roots of held projects whose state is newer than the snapshot
	 * (`projects_rev`) — applied from a reply or notification after the
	 * snapshot was read, so its files under them may be older than what's
	 * here.
	 */
	newer: Array<DiskfileDirectoryPath>;
	/**
	 * Roots the snapshot lists that the rev rule kept out — closed here after
	 * the snapshot was read — so its files under them are added only where
	 * another root still indexes them.
	 */
	refused: Array<DiskfileDirectoryPath>;
}

/**
 * Whether the daemon resynced `dir` between two states of a project: its
 * `ignored` entry's `resyncs` count moved, or the entry came or went (a git
 * root falling back to fixed names) — either way the `filer_change`s for
 * what that re-prune changed weren't sent, so the directory is pulled.
 * A change of the paths alone isn't one: live-vetted files join the set
 * without the index changing, and a re-prune small enough to send its
 * changes sends them.
 */
export const is_resynced = (
	before: Readonly<Record<string, ProjectIgnoredJson>>,
	after: Readonly<Record<string, ProjectIgnoredJson>>,
	dir: DiskfileDirectoryPath
): boolean => (before[dir]?.resyncs ?? null) !== (after[dir]?.resyncs ?? null);

/**
 * Collection of open projects, keyed by root.
 */
export class Projects extends Cell<typeof ProjectsJson> {
	readonly items: IndexedCollection<Project> = new IndexedCollection({
		dispose_item: (project) => project.dispose(),
		indexes: [
			create_single_index({
				key: 'by_root',
				extractor: (project) => project.root,
				immutable_key: true // `add` dedupes by root, and the root is never reassigned
			})
		]
	});

	active_id: Uuid | null = $state.raw()!;

	readonly active: Project | undefined = $derived(
		this.active_id ? this.items.by_id.get(this.active_id) : undefined
	);

	/**
	 * The open registry projects' present entries — their repos — by dir,
	 * each to its project: what the file tree shows under a registry's root,
	 * focused or not.
	 */
	readonly repos: ReadonlyMap<string, Project> = $derived.by(() => {
		const repos: Map<DiskfileDirectoryPath, Project> = new Map();
		for (const project of this.items.values) {
			if (project.kind !== 'registry') continue;
			for (const entry of project.entries) {
				if (entry.state === 'present') repos.set(entry.dir, project);
			}
		}
		return repos;
	});

	/** The repos with a `focus_repo` or `unfocus_repo` in flight from this client, by dir. */
	readonly pending_repos: SvelteSet<DiskfileDirectoryPath> = new SvelteSet();

	constructor(options: ProjectsOptions) {
		super(ProjectsJson, options);

		this.decoders = {
			items: create_collection_decoder(
				() => this.items.clear(),
				(json) => this.add(json)
			)
		};

		this.init();
	}

	// not reactive — the rev rule's bookkeeping (see `#apply`)
	/**
	 * Per root closed here — by a reply or a notification — the close's rev:
	 * a tombstone, so an older reply or notification can't add the project
	 * back.
	 */
	readonly #closed: Map<DiskfileDirectoryPath, number> = new Map();
	/**
	 * The `projects_rev` of the last session snapshot applied. State of a
	 * root not held at or below it is stale: the snapshot listed the root, or
	 * saw it closed — so the tombstones at or below it are dropped.
	 */
	#floor = -1;
	/**
	 * Per held project, each focused directory with the rev of the state
	 * that focused it, or that last resynced it (`is_resynced`) — a
	 * `repo_files` reply read before it is of an earlier focus of the repo,
	 * or of the index a resync replaced, and dropped.
	 */
	readonly #focused_since: Map<DiskfileDirectoryPath, Map<DiskfileDirectoryPath, number>> =
		new Map();
	/** This client's opens and focuses in flight, whose replies carry files. */
	#in_flight = 0;
	/**
	 * Per root, the directories whose files a state applied here needs and
	 * no applied reply has carried yet, each with that state's rev — the root
	 * among them for a project new here. Held while this client's own opens
	 * and focuses are in flight: this client's own `project_changed` arrives
	 * before its own reply, which carries the files. Then each is pulled
	 * (`repo_files`), or the session resynced for a project new here.
	 */
	readonly #pending: Map<DiskfileDirectoryPath, Map<DiskfileDirectoryPath, number>> = new Map();
	/**
	 * The roots of `#pending` whose project is new here — the session is
	 * resynced for them. Apart from `#pending`'s root entry: a plain git
	 * checkout's root is also its one focus, pending when resynced, and
	 * that's pulled (`repo_files`), not a session resync.
	 */
	readonly #pending_new: Set<DiskfileDirectoryPath> = new Set();
	#received = 0;

	/**
	 * How many project states and closes from the daemon this has received —
	 * applied or dropped by the rev rule — a counter, compared before and
	 * after a session snapshot is in flight (`Frontend.receive_session`):
	 * across a restart revs can't order the new instance's state against the
	 * old one's, so dropped state counts too.
	 */
	get received(): number {
		return this.#received;
	}

	/**
	 * Adds a project as given, or updates the one at its root — local state,
	 * not the rev rule: for decoding and seeding. State from the daemon goes
	 * through `receive_remote_change`, the replies of `open` / `focus_repo`
	 * / `unfocus_repo`, `receive_closed`, and `reconcile`.
	 *
	 * @param options.activate - make it the active project when none is
	 *   (default `true`)
	 */
	add(json: ProjectJsonInput, options?: { activate?: boolean }): Project {
		const existing = this.get_by_root(json.root as DiskfileDirectoryPath);
		const project = existing ?? this.#create(json, options?.activate !== false);
		if (existing) existing.set_json_partial({ ...json, id: undefined });
		this.#track_focus(project, project.rev);
		return project;
	}

	#create(json: ProjectJsonInput, activate: boolean): Project {
		const project = new Project({ app: this.app, json });
		this.items.add(project);
		if (this.active_id === null && activate) this.active_id = project.id;
		return project;
	}

	/**
	 * Records when each of `project`'s focused directories was focused: `rev`
	 * for one newly focused, the earlier rev kept for one still focused.
	 */
	#track_focus(project: Project, rev: number): void {
		let since = this.#focused_since.get(project.root);
		if (!since) this.#focused_since.set(project.root, (since = new Map()));
		for (const dir of since.keys()) {
			if (!project.focused.includes(dir)) since.delete(dir);
		}
		for (const dir of project.focused) {
			if (!since.has(dir)) since.set(dir, rev);
		}
	}

	/**
	 * Applies a project's state from the daemon by the rev rule: a held
	 * project takes it only when `json.rev` is newer than the rev held, and a
	 * root not held is added only when `json.rev` beats its tombstone and the
	 * last snapshot's `projects_rev`. Older state is dropped whole — a reply's
	 * files with it (the callers check the rev held).
	 *
	 * A newer state that narrows — drops a focus, a kind change included,
	 * since a checkout's or plain directory's one focus is its root — leaves
	 * files the daemon no longer indexes, and stopping a filer deletes
	 * nothing here, so they're released (`Diskfiles.release_uncovered`).
	 * A newer state that widens needs the files of what it added, which
	 * `covered` may carry; the rest go pending (see `#pending`). So does a
	 * focused directory the daemon resynced (`is_resynced`): it re-pruned
	 * the directory without sending each change, and the pull reconciles
	 * the directory whole — the files it no longer indexes pruned, the ones
	 * it now does added.
	 *
	 * @param covered - the directories whose files arrive with `json`: a
	 *   reply's, or `all` for a session snapshot, whose files cover every
	 *   project it lists
	 * @param activate - make a project new here the active one when none is
	 * @returns the project held at `json.root` afterward, if any, and whether
	 *   `json` was applied
	 */
	#apply(
		json: ProjectInfoJson,
		covered: ReadonlyArray<DiskfileDirectoryPath> | 'all',
		activate: boolean
	): { project: Project | undefined; applied: boolean } {
		this.#received++;
		const held = this.get_by_root(json.root);
		if (held) {
			if (json.rev <= held.rev) return { project: held, applied: false };
		} else if (json.rev <= Math.max(this.#closed.get(json.root) ?? -1, this.#floor)) {
			return { project: undefined, applied: false };
		}
		// a project held at an unknown rev (across a restart) is new here: what
		// this client has of it says nothing of what the daemon indexes now
		const before =
			held && held.rev >= 0
				? { kind: held.kind, focused: [...held.focused], ignored: held.ignored }
				: null;
		const was_focused = held ? [...held.focused] : [];
		let project: Project;
		if (held) {
			held.set_json_partial({ ...json, id: undefined });
			project = held;
			if (!before) this.#focused_since.delete(json.root);
		} else {
			this.#closed.delete(json.root);
			project = this.#create(json, activate);
		}
		this.#track_focus(project, json.rev);

		const dropped = was_focused.filter((dir) => !json.focused.includes(dir));
		if (dropped.length) this.app.diskfiles.release_uncovered(dropped);

		// a pull read before a resync is of the index the resync replaced, so
		// it's dropped as one of an earlier focus is, in whatever order it lands
		if (before) {
			const since = this.#focused_since.get(json.root);
			for (const dir of json.focused) {
				if (is_resynced(before.ignored, json.ignored, dir)) {
					since?.set(dir, json.rev);
				}
			}
		}

		if (covered === 'all') return { project, applied: true };
		let pending = this.#pending.get(json.root);
		const needed =
			before === null
				? [json.root, ...json.focused]
				: json.focused.filter(
						(dir) => !before.focused.includes(dir) || is_resynced(before.ignored, json.ignored, dir)
					);
		for (const dir of needed) {
			if (covered.includes(dir)) continue;
			if (!pending) this.#pending.set(json.root, (pending = new Map()));
			pending.set(dir, json.rev);
		}
		if (before === null && pending?.has(json.root)) this.#pending_new.add(json.root);
		if (pending?.size === 0) this.#pending.delete(json.root);
		return { project, applied: true };
	}

	/**
	 * Drops what `#pending` holds of `covered` at or below `rev`: a reply at
	 * `rev` whose state is the one held carried their files.
	 */
	#settle(
		root: DiskfileDirectoryPath,
		covered: ReadonlyArray<DiskfileDirectoryPath>,
		rev: number
	): void {
		const pending = this.#pending.get(root);
		if (!pending) return;
		for (const dir of covered) {
			const since = pending.get(dir);
			// defensive: every caller settles at the rev held, so nothing pending is newer
			if (since !== undefined && since <= rev) pending.delete(dir);
		}
		if (!pending.has(root)) this.#pending_new.delete(root);
		if (pending.size === 0) this.#pending.delete(root);
	}

	/**
	 * Handles a `project_changed` open or update — broadcast for every change,
	 * this client's own included — by the rev rule (`#apply`). The
	 * notification carries none of the files (a filer's initial scan
	 * broadcasts nothing), so what it adds is fetched once no open or focus
	 * of this client's is in flight: a new focus on a known project by
	 * pulling that repo alone (`repo_files`), a project new here (opened
	 * elsewhere — another tab, `zzz <path>`) by resyncing the session
	 * (`Frontend.resync_session`). A reply of this client's at or after the
	 * notification's rev that carries the files makes the fetch unneeded.
	 */
	receive_remote_change(json: ProjectInfoJson): void {
		this.#apply(json, [], false);
		this.#flush();
	}

	/**
	 * Applies a close at `rev` of the project at `root` — a `project_close`
	 * reply, or a `project_changed` close, this client's or another's — unless
	 * the state held is newer (opened again after the close), which it leaves
	 * as it is. Otherwise it leaves a tombstone, so no older reply or
	 * notification adds the project back, and removes the project if held.
	 * Its files no other root covers are released (`#remove_closed`).
	 *
	 * @returns whether the close is newer than the state held — `false` when
	 *   the project held was opened again since
	 */
	receive_closed(root: DiskfileDirectoryPath, rev: number): boolean {
		this.#received++;
		const held = this.get_by_root(root);
		if (held && held.rev > rev) return false;
		this.#closed.set(root, Math.max(this.#closed.get(root) ?? -1, rev));
		if (held) this.#remove_closed(held);
		return true;
	}

	/**
	 * Removes `project`, closed on the daemon, and releases its files — its
	 * filers are stopped, and stopping a filer deletes nothing here — keeping
	 * what another root still covers, and a file with a draft, flagged
	 * deleted (`Diskfiles.release_uncovered`).
	 */
	#remove_closed(project: Project): void {
		this.remove(project.id);
		this.app.diskfiles.release_uncovered([project.root]);
	}

	/**
	 * Fetches the files of `dir`, a focused repo of the project at `root`
	 * whose files no reply carried (`repo_files`), and reconciles them —
	 * around what `filer_change` reported meanwhile, as a focus's reply is.
	 * A read of a focus older than the one held here is dropped: across an
	 * unfocus and a focus again, it would prune files created between. A
	 * focus gone by the time the reply lands (here, or `repo_not_focused`
	 * from the daemon) leaves things to the `project_changed` that dropped
	 * it; any other failure resyncs.
	 */
	async #pull_repo(root: DiskfileDirectoryPath, dir: DiskfileDirectoryPath): Promise<void> {
		const changes = this.app.diskfiles.track_changes();
		let result: Awaited<ReturnType<typeof this.app.api.repo_files>>;
		try {
			result = await this.app.api.repo_files({ root, dir });
		} finally {
			changes.stop();
		}
		if (!result.ok) {
			const { reason } = (result.error.data ?? {}) as { reason?: unknown };
			if (reason !== ERROR_REPO_NOT_FOCUSED && reason !== ERROR_PROJECT_NOT_OPEN) {
				this.app.resync_session();
			}
			return;
		}
		const since = this.#focused_since.get(root)?.get(dir);
		const project = this.get_by_root(root);
		if (!project || since === undefined || result.value.rev < since) return;
		project.watch_status = result.value.watch_status;
		this.app.diskfiles.reconcile(result.value.files, [dir], { changes });
	}

	/**
	 * Once no open or focus of this client's is in flight, fetches what
	 * `#pending` holds: each repo still focused pulled alone — a checkout's
	 * root too — or the session resynced for a project new here
	 * (`#pending_new`).
	 */
	#flush(): void {
		if (this.#in_flight > 0 || this.#pending.size === 0) return;
		const pending = Array.from(this.#pending);
		const pending_new = new Set(this.#pending_new);
		this.#pending.clear();
		this.#pending_new.clear();
		let resync = false;
		for (const [root, dirs] of pending) {
			const project = this.get_by_root(root);
			if (!project) continue;
			// a project new here: a registry's top level isn't a repo to pull
			if (pending_new.has(root)) {
				resync = true;
				continue;
			}
			for (const dir of dirs.keys()) {
				if (project.focused.includes(dir)) void this.#pull_repo(root, dir);
			}
		}
		if (resync) this.app.resync_session();
	}

	/**
	 * Opens the project holding `path` on the backend (`project_open`), which
	 * focuses the repo holding it, then applies the reply by the rev rule
	 * (`#apply`) with its files, around what `filer_change` reported while the
	 * request was in flight (see `Diskfiles.track_changes`). The files are the
	 * index of the reply's state, so they're applied only when that state is
	 * the one held: a newer state held may index less, and its own change
	 * fetches what it adds.
	 *
	 * @param path - the file or directory to open; the daemon resolves its
	 * project, whose root may be far above it
	 * @param options.reconcile_files - replace the known files under the
	 * project's focused directories with its index (`Diskfiles.reconcile`)
	 * instead of only adding — for reopening a project whose files the app
	 * already has. Only focused directories are complete trees, so files
	 * elsewhere under the root are left alone.
	 * @param options.focus - registry entry dirs to focus in the same open,
	 * each landing or refused alone (`ProjectOpened.refused`)
	 * @returns the project, the open's focus, whether it created the project,
	 * and the refused focuses, or the RPC error
	 */
	async open(
		path: DiskfilePath,
		options?: { reconcile_files?: boolean; focus?: ReadonlyArray<DiskfileDirectoryPath> }
	): Promise<Result<{ value: ProjectOpened }, { error: JsonrpcErrorObject }>> {
		const changes = this.app.diskfiles.track_changes();
		this.#in_flight++;
		try {
			let result: Awaited<ReturnType<typeof this.app.api.project_open>>;
			try {
				result = await this.app.api.project_open(
					options?.focus?.length ? { path, focus: [...options.focus] } : { path }
				);
			} finally {
				changes.stop();
			}
			if (!result.ok) return result;

			const { project: json, focus, watch_status, files, refused, opened } = result.value;
			const covered = [json.root, ...json.focused];
			const { project } = this.#apply(json, covered, true);
			if (project) {
				if (focus !== null) project.last_focus = focus;
				if (project.rev === json.rev) {
					this.#settle(json.root, covered, json.rev);
					project.watch_status = watch_status;
					if (options?.reconcile_files) {
						this.app.diskfiles.reconcile(files, json.focused, { changes });
					} else {
						this.app.diskfiles.add_initial(files, changes);
					}
				}
			}
			return {
				ok: true,
				value: { project: project ?? null, focus, opened, rev: json.rev, refused }
			};
		} finally {
			// on every exit, a throw included, so pending fetches always go out
			this.#in_flight--;
			this.#flush();
		}
	}

	/**
	 * Focuses `dir`, a present registry entry of the open project at `root`, on
	 * the backend (`repo_focus`) — its files are then indexed, as opening a
	 * path in it would — and applies the reply by the rev rule with the repo's
	 * files, around what `filer_change` reported while the request was in
	 * flight. The reply covers the repo whole, so a file known under it that
	 * the reply lacks is gone from disk (`Diskfiles.reconcile` — one kept for
	 * its draft while the repo was unfocused is flagged deleted). Its files
	 * are applied only when its state is the one held, as an open's are.
	 *
	 * @returns the project held, `null` when it's closed here meanwhile, or
	 * the RPC error
	 */
	async focus_repo(
		root: DiskfileDirectoryPath,
		dir: DiskfileDirectoryPath
	): Promise<Result<{ value: Project | null }, { error: JsonrpcErrorObject }>> {
		const changes = this.app.diskfiles.track_changes();
		this.#in_flight++;
		this.pending_repos.add(dir);
		try {
			let result: Awaited<ReturnType<typeof this.app.api.repo_focus>>;
			try {
				result = await this.app.api.repo_focus({ root, dir });
			} finally {
				changes.stop();
			}
			if (!result.ok) return result;
			const { project: json, watch_status, files } = result.value;
			const { project } = this.#apply(json, [dir], true);
			if (project?.rev === json.rev) {
				this.#settle(json.root, [dir], json.rev);
				project.watch_status = watch_status;
				this.app.diskfiles.reconcile(files, [dir], { changes });
			}
			return { ok: true, value: project ?? null };
		} finally {
			this.pending_repos.delete(dir);
			this.#in_flight--;
			this.#flush();
		}
	}

	/**
	 * Unfocuses `dir`, a registry entry of the open project at `root`, on the
	 * backend (`repo_unfocus`), and applies the reply by the rev rule — which
	 * releases the repo's files here (`Diskfiles.release_uncovered`): the
	 * index no longer covers them. A reply older than the state held changes
	 * nothing, so it can't drop a focus another client added since.
	 *
	 * @returns the project held, `null` when it's closed here meanwhile, or
	 * the RPC error
	 */
	async unfocus_repo(
		root: DiskfileDirectoryPath,
		dir: DiskfileDirectoryPath
	): Promise<Result<{ value: Project | null }, { error: JsonrpcErrorObject }>> {
		this.pending_repos.add(dir);
		try {
			const result = await this.app.api.repo_unfocus({ root, dir });
			if (!result.ok) return result;
			const { project } = this.#apply(result.value.project, [], true);
			this.#flush();
			return { ok: true, value: project ?? null };
		} finally {
			this.pending_repos.delete(dir);
		}
	}

	remove(id: Uuid): void {
		const project = this.items.by_id.get(id);
		if (!project) return;
		this.items.remove(id);
		this.#focused_since.delete(project.root);
		this.#pending.delete(project.root);
		this.#pending_new.delete(project.root);
		this.app.diskfiles.handle_project_removed(project.root);
		if (id === this.active_id) {
			const next = this.items.by_id.values().next();
			this.active_id = next.value?.id ?? null;
		}
	}

	/**
	 * Reconciles the open projects with a session snapshot read at
	 * `projects_rev`: applies each project it lists by the rev rule
	 * (`#apply`), and removes a held project it doesn't list when what's held
	 * of it is no newer than the snapshot — the daemon closed it — unless
	 * `keep_unlisted` (after a restart the caller reopens them instead) or
	 * it's in `keep_roots`. A held project newer than the snapshot is left as
	 * it is, and named in `newer`, under which the caller prunes nothing; a
	 * listed root closed here since the snapshot was read stays closed, named
	 * in `refused`. Under either, the caller adds only the snapshot's files
	 * the index held still covers.
	 *
	 * Then `projects_rev` is the floor below which a root not held stays
	 * closed, and what `#pending` held of the projects it covered is settled.
	 *
	 * @param projects - the snapshot's projects
	 * @param projects_rev - the snapshot's `projects_rev`
	 * @param options.keep_unlisted - keep the projects the snapshot doesn't list
	 * @param options.keep_roots - roots never removed or counted unlisted —
	 *   ones a reopen is in flight or pending for
	 */
	reconcile(
		projects: ReadonlyArray<ProjectInfoJson>,
		projects_rev: number,
		options?: { keep_unlisted?: boolean; keep_roots?: ReadonlySet<string> }
	): ProjectsReconciled {
		const listed: Set<string> = new Set();
		const refused: Array<DiskfileDirectoryPath> = [];
		for (const info of projects) {
			listed.add(info.root);
			if (!this.#apply(info, 'all', true).project) refused.push(info.root);
		}
		const unlisted: Array<DiskfileDirectoryPath> = [];
		const newer: Array<DiskfileDirectoryPath> = [];
		for (const project of [...this.items.values]) {
			if (project.rev > projects_rev) {
				newer.push(project.root);
				continue;
			}
			if (listed.has(project.root) || options?.keep_roots?.has(project.root)) continue;
			unlisted.push(project.root);
			if (!options?.keep_unlisted) this.remove(project.id);
		}
		this.#floor = Math.max(this.#floor, projects_rev);
		for (const [root, rev] of this.#closed) {
			if (rev <= this.#floor) this.#closed.delete(root);
		}
		// the snapshot's files cover what a state no newer than it needed
		for (const [root, dirs] of this.#pending) {
			if (newer.includes(root)) continue;
			for (const [dir, rev] of dirs) {
				if (rev <= projects_rev) dirs.delete(dir);
			}
			if (!dirs.has(root)) this.#pending_new.delete(root);
			if (dirs.size === 0) this.#pending.delete(root);
		}
		return { unlisted, newer, refused };
	}

	/**
	 * Forgets every rev held — each project's becomes unknown (`-1`), which
	 * any state from the daemon replaces — with the tombstones, the floor,
	 * and what's pending: a session snapshot from a restarted daemon
	 * (`Frontend.receive_session`) is the truth, whatever revs the last
	 * instance stamped.
	 */
	reset_revs(): void {
		for (const project of this.items.values) project.rev = -1;
		this.#closed.clear();
		this.#floor = -1;
		this.#focused_since.clear();
		this.#pending.clear();
		this.#pending_new.clear();
	}

	get_by_root(root: DiskfileDirectoryPath): Project | undefined {
		return this.items.by_optional('by_root', root);
	}

	/**
	 * Removes the project at `root` here, if one exists, leaving a tombstone
	 * at the rev held and releasing its files (`#remove_closed`) — for a close
	 * the daemon can't stamp: its project isn't open there
	 * (`project_not_open`), or a reopen was refused.
	 */
	remove_by_root(root: DiskfileDirectoryPath): void {
		const project = this.get_by_root(root);
		if (!project) return;
		this.#closed.set(root, Math.max(this.#closed.get(root) ?? -1, project.rev));
		this.#remove_closed(project);
	}

	activate(id: Uuid): void {
		if (this.items.by_id.has(id)) {
			this.active_id = id;
		}
	}
}
