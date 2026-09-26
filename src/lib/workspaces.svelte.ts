import { z } from 'zod';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';
import { HANDLED } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { create_single_index } from './indexed_collection_helpers.svelte.ts';
import {
	Workspace,
	WorkspaceJson,
	type WorkspaceInfoJson,
	type WorkspaceJsonInput
} from './workspace.svelte.ts';
import type { DiskfileDirectoryPath } from './diskfile_types.ts';

// TODO: workspace history — soft-close keeps workspace in set for later re-opening (needs DB)
// TODO: pull-based lazy activation — only start Filers when a client connects or requests data
// TODO: hooks/automation — respond to fs events within workspaces

export const WorkspacesJson = CellJson.extend({
	items: z.array(WorkspaceJson).default(() => []),
	active_id: z.string().nullable().default(null)
}).meta({ cell_class_name: 'Workspaces' });
export type WorkspacesJson = z.infer<typeof WorkspacesJson>;
export type WorkspacesJsonInput = z.input<typeof WorkspacesJson>;

export interface WorkspacesOptions extends CellOptions<typeof WorkspacesJson> {}

/** Records the workspace paths added or removed while a session snapshot is in flight. */
export interface WorkspaceChangeTracker {
	/** Paths `add` or `remove` touched since tracking started. */
	readonly paths: ReadonlySet<string>;
	/** Stops recording. */
	stop: () => void;
}

/**
 * Collection of open workspaces.
 *
 * Manages the set of directories the daemon is watching and serving.
 * Each workspace has a unique path used as the index key.
 */
export class Workspaces extends Cell<typeof WorkspacesJson> {
	readonly items: IndexedCollection<Workspace> = new IndexedCollection({
		dispose_item: (workspace) => workspace.dispose(),
		indexes: [
			create_single_index({
				key: 'by_path',
				extractor: (workspace) => workspace.path,
				query_schema: z.string(),
				immutable_key: true // `add` dedupes by path, and the path is never reassigned
			})
		]
	});

	active_id: Uuid | null = $state.raw()!;

	readonly active: Workspace | undefined = $derived(
		this.active_id ? this.items.by_id.get(this.active_id) : undefined
	);

	constructor(options: WorkspacesOptions) {
		super(WorkspacesJson, options);

		this.decoders = {
			items: (items) => {
				if (Array.isArray(items)) {
					this.items.clear();
					for (const item_json of items) {
						this.add(item_json);
					}
				}
				return HANDLED;
			}
		};

		this.init();
	}

	// not reactive — bookkeeping for snapshot requests in flight
	readonly #change_trackers: Set<Set<string>> = new Set();

	/**
	 * Starts recording the workspace paths `add` and `remove` touch. Start it
	 * before requesting a session snapshot and pass its `paths` to `reconcile`,
	 * so the snapshot doesn't undo an open or close that happened while the
	 * request was in flight.
	 */
	track_changes(): WorkspaceChangeTracker {
		const paths: Set<string> = new Set();
		this.#change_trackers.add(paths);
		return { paths, stop: () => this.#change_trackers.delete(paths) };
	}

	/**
	 * Add a workspace. If a workspace with the same path already exists, returns it.
	 */
	add(json: WorkspaceJsonInput): Workspace {
		for (const paths of this.#change_trackers) paths.add(json.path);
		const existing = this.get_by_path(json.path as DiskfileDirectoryPath);
		if (existing) return existing;

		const workspace = new Workspace({ app: this.app, json });
		this.items.add(workspace);

		// Auto-activate if no active workspace
		if (this.active_id === null) {
			this.active_id = workspace.id;
		}

		return workspace;
	}

	/**
	 * Opens the workspace at `path` on the backend (`workspace_open`), then adds it
	 * with its file tree. Tree entries for paths a `filer_change` touched while the
	 * request was in flight are skipped, since the notification is at least as new
	 * (see `Diskfiles.track_changes`).
	 *
	 * @param path - the directory to open; the daemon canonicalizes it, so the
	 * returned workspace's path may differ
	 * @param options.reconcile_files - replace the known files under the
	 * workspace with its tree (`Diskfiles.reconcile`) instead of only adding —
	 * for reopening a workspace whose files the app already has
	 * @returns the opened workspace, or the RPC error
	 */
	async open(
		path: DiskfileDirectoryPath,
		options?: { reconcile_files?: boolean }
	): Promise<Result<{ value: Workspace }, { error: JsonrpcErrorObject }>> {
		const changes = this.app.diskfiles.track_changes();
		let result: Awaited<ReturnType<typeof this.app.api.workspace_open>>;
		try {
			result = await this.app.api.workspace_open({ path });
		} finally {
			changes.stop();
		}
		if (!result.ok) return result;

		const { workspace: workspace_json, watch_status, files } = result.value;
		const workspace = this.add(workspace_json);
		workspace.watch_status = watch_status;
		if (options?.reconcile_files) {
			this.app.diskfiles.reconcile(files, [workspace.path], { skip_paths: changes.paths });
		} else {
			this.app.diskfiles.add_initial(files, changes.paths);
		}
		return { ok: true, value: workspace };
	}

	remove(id: Uuid): void {
		const workspace = this.items.by_id.get(id);
		if (!workspace) return;
		for (const paths of this.#change_trackers) paths.add(workspace.path);
		this.items.remove(id);
		if (id === this.active_id) {
			const next = this.items.by_id.values().next();
			this.active_id = next.value?.id ?? null;
		}
	}

	/**
	 * Reconciles the open workspaces with a session snapshot's: adds the ones it
	 * lists, and removes the ones it doesn't — the backend closed them — unless
	 * `keep_unlisted` (after a restart the caller reopens them instead).
	 *
	 * @param workspaces - the snapshot's workspaces
	 * @param options.skip_paths - paths left as they are, e.g. ones opened or
	 *   closed while the snapshot was in flight (see `track_changes`)
	 * @param options.keep_unlisted - keep the workspaces the snapshot doesn't list
	 * @returns the paths of the open workspaces the snapshot doesn't list (outside
	 *   `skip_paths`) — removed unless `keep_unlisted`
	 */
	reconcile(
		workspaces: ReadonlyArray<WorkspaceInfoJson>,
		options?: { skip_paths?: ReadonlySet<string>; keep_unlisted?: boolean }
	): Array<DiskfileDirectoryPath> {
		const skip_paths = options?.skip_paths;
		const listed: Set<string> = new Set();
		for (const info of workspaces) {
			listed.add(info.path);
			if (!skip_paths?.has(info.path)) this.add(info);
		}
		const unlisted: Array<DiskfileDirectoryPath> = [];
		for (const workspace of this.items.values) {
			if (listed.has(workspace.path) || skip_paths?.has(workspace.path)) continue;
			unlisted.push(workspace.path);
			if (!options?.keep_unlisted) this.remove(workspace.id);
		}
		return unlisted;
	}

	get_by_path(path: DiskfileDirectoryPath): Workspace | undefined {
		return this.items.by_optional('by_path', path);
	}

	/**
	 * Remove the workspace at `path`, if one exists. No-op when absent.
	 */
	remove_by_path(path: DiskfileDirectoryPath): void {
		const workspace = this.get_by_path(path);
		if (workspace) this.remove(workspace.id);
	}

	activate(id: Uuid): void {
		if (this.items.by_id.has(id)) {
			this.active_id = id;
		}
	}
}
