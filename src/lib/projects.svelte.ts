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

/** Records the project roots added or removed while a session snapshot is in flight. */
export interface ProjectChangeTracker {
	/** Roots `add` or `remove` touched since tracking started. */
	readonly roots: ReadonlySet<string>;
	/** Stops recording. */
	stop: () => void;
}

/**
 * What `Projects.open` returns: the project, the directory the open focused,
 * and the requested focuses that didn't land.
 */
export interface ProjectOpened {
	project: Project;
	/** The directory the open focused, or `null` — a registry's root, or a directory in no entry. */
	focus: DiskfileDirectoryPath | null;
	/** Each of `options.focus` that didn't land, with the daemon's reason. */
	refused: Array<ProjectFocusRefusal>;
}

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

	// not reactive — bookkeeping for snapshot requests in flight
	readonly #change_trackers: Set<Set<string>> = new Set();

	/**
	 * Starts recording the project roots `add` and `remove` touch. Start it
	 * before requesting a session snapshot and pass its `roots` to `reconcile`,
	 * so the snapshot doesn't undo an open or close that happened while the
	 * request was in flight.
	 */
	track_changes(): ProjectChangeTracker {
		const roots: Set<string> = new Set();
		this.#change_trackers.add(roots);
		return { roots, stop: () => this.#change_trackers.delete(roots) };
	}

	// not reactive — bookkeeping for `receive_remote_change`: opens and focuses in flight
	#opening = 0;
	/**
	 * Per root, the directories a remote change brought into the project
	 * (its root, for a project new here) whose files no reply has carried
	 * yet — deferred while this client's own opens and focuses are in flight,
	 * then pulled (`repo_files`), or resynced for a project new here.
	 */
	readonly #remote_pending: Map<DiskfileDirectoryPath, Set<DiskfileDirectoryPath>> = new Map();
	/**
	 * Whether a change while opens were in flight dropped a focus or changed
	 * a project's kind — files the daemon no longer indexes, which no reply
	 * or notification deletes, so only a resync prunes them.
	 */
	#resync_after_opens = false;

	/**
	 * Add a project. If one with the same root already exists, it takes the
	 * newer state (`Cell.set_json_partial`) and is returned.
	 *
	 * @param options.activate - make it the active project when none is
	 *   (default `true`)
	 * @param options.keep_focus - keep the focused directories it already has
	 *   that `json`'s kind and entries still support (`is_focus_supported`)
	 *   alongside `json`'s — for an open's reply, which may predate a
	 *   `project_changed` that added a focus, while a focus its resolve no
	 *   longer supports is one the daemon dropped
	 */
	add(json: ProjectJsonInput, options?: { activate?: boolean; keep_focus?: boolean }): Project {
		for (const roots of this.#change_trackers) roots.add(json.root);
		const existing = this.get_by_root(json.root as DiskfileDirectoryPath);
		if (existing) {
			const focused =
				options?.keep_focus && json.focused
					? Array.from(
							new Set([
								...existing.focused.filter((dir) => is_focus_supported(json, dir)),
								...json.focused
							])
						).sort()
					: json.focused;
			existing.set_json_partial({ ...json, focused, id: undefined });
			return existing;
		}

		const project = new Project({ app: this.app, json });
		this.items.add(project);

		if (this.active_id === null && options?.activate !== false) {
			this.active_id = project.id;
		}

		return project;
	}

	/**
	 * Handles a `project_changed` open or update — broadcast for every change,
	 * this client's own included. The notification carries none of the files
	 * (a filer's initial scan broadcasts nothing), so they're fetched: a
	 * project this client doesn't know, opened elsewhere (another tab, `zzz
	 * <path>`), by resyncing the session (`Frontend.resync_session`), and a
	 * new focus on a known project by pulling that repo alone (`repo_files`).
	 * While this client's own `open` is in flight the notification may be its
	 * own, landing before the reply that carries the files, so the fetch waits
	 * for the opens to settle, and is skipped for what their replies carried —
	 * a reply built before another client's focus doesn't cover that focus.
	 *
	 * A change that drops focuses needs their files released, since stopping a
	 * filer deletes nothing here: an unfocus — only focuses on entries still
	 * present dropped, the kind unchanged, no open or focus in flight —
	 * releases them at once (`Diskfiles.release_unfocused`); any other drop
	 * resyncs, once no open or focus is in flight (a reply may bring the
	 * files back).
	 */
	receive_remote_change(json: ProjectInfoJson): void {
		const known = this.get_by_root(json.root);
		const before = known ? { kind: known.kind, focused: [...known.focused] } : null;
		this.add(json, { activate: false }); // records the change for `track_changes` either way
		// a snapshot in flight skips this root (`track_changes`), pruning nothing
		// under it, so ask for one after it
		if (this.app.session_status === 'pending') this.app.resync_session();
		const needed: Array<DiskfileDirectoryPath> =
			before === null
				? [json.root, ...json.focused]
				: json.focused.filter((dir) => !before.focused.includes(dir));
		const dropped = before !== null && is_narrowed(before, json);
		if (!needed.length && !dropped) return;
		if (this.#opening === 0 && !needed.length && before?.kind === json.kind) {
			// only focuses dropped, with no reply in flight that could bring their
			// files back — release what the index no longer covers here, without a
			// snapshot: an unfocused repo's files go, those with a draft or tab
			// stay (a repo dropped otherwise — gone, or out of the registry — is
			// the snapshot's)
			const unfocused = before.focused.filter((dir) => !json.focused.includes(dir));
			if (unfocused.every((dir) => this.repos.get(dir)?.root === json.root)) {
				for (const dir of unfocused) this.app.diskfiles.release_unfocused(dir);
				return;
			}
		}
		if (this.#opening > 0) {
			let pending = this.#remote_pending.get(json.root);
			if (!pending && needed.length) this.#remote_pending.set(json.root, (pending = new Set()));
			for (const dir of needed) pending!.add(dir);
			if (dropped) this.#resync_after_opens = true;
		} else if (before !== null && !dropped) {
			for (const dir of needed) void this.#pull_repo(json.root, dir);
		} else {
			this.app.resync_session();
		}
	}

	/**
	 * Fetches the files of `dir`, a repo of the project at `root` that another
	 * client focused (`repo_files`), and reconciles them — around what
	 * `filer_change` reported meanwhile, as a focus's reply is. A focus gone
	 * by the time the reply lands (here, or `repo_not_focused` from the
	 * daemon) leaves things to the `project_changed` that dropped it; any
	 * other failure resyncs.
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
		const project = this.get_by_root(root);
		if (!project?.focused.includes(dir)) return;
		project.watch_status = result.value.watch_status;
		this.app.diskfiles.reconcile(result.value.files, [dir], { changes });
	}

	/**
	 * Opens the project holding `path` on the backend (`project_open`), which
	 * focuses the repo holding it, then adds the project with its files,
	 * applied around what `filer_change` reported while the request was in
	 * flight (see `Diskfiles.track_changes`).
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
	 * @returns the project, the open's focus, and the refused focuses, or the
	 * RPC error
	 */
	async open(
		path: DiskfilePath,
		options?: { reconcile_files?: boolean; focus?: ReadonlyArray<DiskfileDirectoryPath> }
	): Promise<Result<{ value: ProjectOpened }, { error: JsonrpcErrorObject }>> {
		const changes = this.app.diskfiles.track_changes();
		this.#opening++;
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

			const { project: project_json, focus, watch_status, files, refused } = result.value;
			const project = this.#receive_reply(project_json, [
				project_json.root,
				...project_json.focused
			]);
			project.watch_status = watch_status;
			if (focus !== null) project.last_focus = focus;
			if (options?.reconcile_files) {
				// the reply's focus, which its files cover — not the focus kept from before
				this.app.diskfiles.reconcile(files, project_json.focused, { changes });
			} else {
				this.app.diskfiles.add_initial(files, changes);
			}
			return { ok: true, value: { project, focus, refused } };
		} finally {
			// on every exit, a throw included, so deferred remote changes are always fetched
			this.#opening--;
			this.#flush_remote_changes();
		}
	}

	/**
	 * Applies the project in an open's or a focus's reply.
	 *
	 * A focus's reply carries its repo alone, so another focus it lists that
	 * this client hadn't heard of (its notification lost with a socket) is
	 * pulled once no open or focus is in flight, as a deferred remote one is.
	 *
	 * @param covered - the directories whose files the reply carries: an
	 *   open's root and every directory it lists focused, a focus's repo alone
	 */
	#receive_reply(
		project_json: ProjectInfoJson,
		covered: ReadonlyArray<DiskfileDirectoryPath>
	): Project {
		const known = this.get_by_root(project_json.root);
		const before = known ? { kind: known.kind, focused: [...known.focused] } : null;
		const project = this.add(project_json, { keep_focus: true });
		// a focus the daemon dropped (a kind change, an entry gone) leaves
		// files it no longer indexes, which only a resync prunes
		if (before !== null && is_narrowed(before, project)) this.#resync_after_opens = true;
		// what a deferred remote change needed of the reply's directories is here
		let pending = this.#remote_pending.get(project.root);
		if (pending) {
			for (const dir of covered) pending.delete(dir);
		}
		for (const dir of project_json.focused) {
			if (before?.focused.includes(dir) || covered.includes(dir)) continue;
			if (!pending) this.#remote_pending.set(project.root, (pending = new Set()));
			pending.add(dir);
		}
		if (pending?.size === 0) this.#remote_pending.delete(project.root);
		return project;
	}

	/**
	 * Focuses `dir`, a present registry entry of the open project at `root`, on
	 * the backend (`repo_focus`) — its files are then indexed, as opening a
	 * path in it would — and adds them, applied around what `filer_change`
	 * reported while the request was in flight. The reply covers the repo
	 * whole, so a file known under it that the reply lacks is gone from disk
	 * (`Diskfiles.reconcile` — one kept for its draft while the repo was
	 * unfocused is flagged deleted).
	 *
	 * @returns the project, or the RPC error
	 */
	async focus_repo(
		root: DiskfileDirectoryPath,
		dir: DiskfileDirectoryPath
	): Promise<Result<{ value: Project }, { error: JsonrpcErrorObject }>> {
		const changes = this.app.diskfiles.track_changes();
		this.#opening++;
		this.pending_repos.add(dir);
		try {
			let result: Awaited<ReturnType<typeof this.app.api.repo_focus>>;
			try {
				result = await this.app.api.repo_focus({ root, dir });
			} finally {
				changes.stop();
			}
			if (!result.ok) return result;
			const { project: project_json, watch_status, files } = result.value;
			const project = this.#receive_reply(project_json, [dir]);
			project.watch_status = watch_status;
			this.app.diskfiles.reconcile(files, [dir], { changes });
			return { ok: true, value: project };
		} finally {
			this.pending_repos.delete(dir);
			this.#opening--;
			this.#flush_remote_changes();
		}
	}

	/**
	 * Unfocuses `dir`, a registry entry of the open project at `root`, on the
	 * backend (`repo_unfocus`), then releases its files here
	 * (`Diskfiles.release_unfocused`): the index no longer covers them. The
	 * reply may predate a change another client made, so it keeps the focus
	 * this client has besides `dir`, as an open's reply does.
	 *
	 * @returns the project, or the RPC error
	 */
	async unfocus_repo(
		root: DiskfileDirectoryPath,
		dir: DiskfileDirectoryPath
	): Promise<Result<{ value: Project }, { error: JsonrpcErrorObject }>> {
		this.pending_repos.add(dir);
		try {
			const result = await this.app.api.repo_unfocus({ root, dir });
			if (!result.ok) return result;
			const reply = result.value.project;
			const project = this.add(reply, { keep_focus: true });
			if (!reply.focused.includes(dir)) {
				project.focused = project.focused.filter((focused) => focused !== dir);
			}
			// a snapshot in flight skips this root (`track_changes`), so ask for one after it
			if (this.app.session_status === 'pending') this.app.resync_session();
			this.app.diskfiles.release_unfocused(dir);
			return { ok: true, value: project };
		} finally {
			this.pending_repos.delete(dir);
		}
	}

	/**
	 * Once no open is in flight, fetches the directories
	 * `receive_remote_change` deferred that no reply of this client carried:
	 * each a repo pulled alone, unless a project is new here (its root among
	 * them) or a focus was dropped, which resync the session.
	 */
	#flush_remote_changes(): void {
		if (this.#opening > 0) return;
		if (this.#remote_pending.size === 0 && !this.#resync_after_opens) return;
		const pending = Array.from(this.#remote_pending);
		this.#remote_pending.clear();
		const resync = this.#resync_after_opens || pending.some(([root, dirs]) => dirs.has(root));
		this.#resync_after_opens = false;
		if (resync) {
			this.app.resync_session();
			return;
		}
		for (const [root, dirs] of pending) {
			for (const dir of dirs) void this.#pull_repo(root, dir);
		}
	}

	remove(id: Uuid): void {
		const project = this.items.by_id.get(id);
		if (!project) return;
		for (const roots of this.#change_trackers) roots.add(project.root);
		this.items.remove(id);
		this.app.diskfiles.handle_project_removed(project.root);
		if (id === this.active_id) {
			const next = this.items.by_id.values().next();
			this.active_id = next.value?.id ?? null;
		}
	}

	/**
	 * Reconciles the open projects with a session snapshot's: adds or updates
	 * the ones it lists, and removes the ones it doesn't — the backend closed
	 * them — unless `keep_unlisted` (after a restart the caller reopens them
	 * instead).
	 *
	 * @param projects - the snapshot's projects
	 * @param options.skip_roots - roots left as they are, e.g. ones opened or
	 *   closed while the snapshot was in flight (see `track_changes`)
	 * @param options.keep_unlisted - keep the projects the snapshot doesn't list
	 * @returns the roots of the open projects the snapshot doesn't list (outside
	 *   `skip_roots`) — removed unless `keep_unlisted`
	 */
	reconcile(
		projects: ReadonlyArray<ProjectInfoJson>,
		options?: { skip_roots?: ReadonlySet<string>; keep_unlisted?: boolean }
	): Array<DiskfileDirectoryPath> {
		const skip_roots = options?.skip_roots;
		const listed: Set<string> = new Set();
		for (const info of projects) {
			listed.add(info.root);
			if (!skip_roots?.has(info.root)) this.add(info);
		}
		const unlisted: Array<DiskfileDirectoryPath> = [];
		for (const project of this.items.values) {
			if (listed.has(project.root) || skip_roots?.has(project.root)) continue;
			unlisted.push(project.root);
			if (!options?.keep_unlisted) this.remove(project.id);
		}
		return unlisted;
	}

	get_by_root(root: DiskfileDirectoryPath): Project | undefined {
		return this.items.by_optional('by_root', root);
	}

	/**
	 * Remove the project at `root`, if one exists. No-op when absent.
	 */
	remove_by_root(root: DiskfileDirectoryPath): void {
		const project = this.get_by_root(root);
		if (project) this.remove(project.id);
	}

	activate(id: Uuid): void {
		if (this.items.by_id.has(id)) {
			this.active_id = id;
		}
	}
}

/**
 * Whether `info`'s kind and entries support `dir` as a focus — what the
 * daemon keeps of an earlier focus when it resolves the project again: a
 * present registry entry's dir, or the root of a checkout or plain
 * directory.
 */
export const is_focus_supported = (
	info: Pick<ProjectJsonInput, 'kind' | 'root' | 'entries'>,
	dir: string
): boolean =>
	info.kind === 'registry'
		? (info.entries ?? []).some((entry) => entry.state === 'present' && entry.dir === dir)
		: dir === info.root;

/**
 * Whether going from `before` to `after` dropped a focus or changed the
 * project's kind — the daemon then indexes less than it did, and stopping a
 * filer deletes nothing on clients.
 */
const is_narrowed = (
	before: { kind: string; focused: ReadonlyArray<string> },
	after: { kind?: string; focused: ReadonlyArray<string> }
): boolean =>
	before.kind !== after.kind || before.focused.some((dir) => !after.focused.includes(dir));
