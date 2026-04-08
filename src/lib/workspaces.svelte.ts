import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';
import {HANDLED} from './cell_helpers.js';
import {IndexedCollection} from './indexed_collection.svelte.js';
import {create_single_index} from './indexed_collection_helpers.svelte.js';
import {Workspace, WorkspaceJson, type WorkspaceJsonInput} from './workspace.svelte.js';
import type {DiskfileDirectoryPath} from './diskfile_types.js';
import type {Uuid} from './zod_helpers.js';

// TODO: workspace history — soft-close keeps workspace in set for later re-opening (needs DB)
// TODO: pull-based lazy activation — only start Filers when a client connects or requests data (see grimoire lore)
// TODO: hooks/automation — respond to fs events within workspaces
// TODO: workspace_open should send the initial file tree to the frontend (currently relies on filer_change notifications)

export const WorkspacesJson = CellJson.extend({
	items: z.array(WorkspaceJson).default(() => []),
	active_id: z.string().nullable().default(null),
}).meta({cell_class_name: 'Workspaces'});
export type WorkspacesJson = z.infer<typeof WorkspacesJson>;
export type WorkspacesJsonInput = z.input<typeof WorkspacesJson>;

export interface WorkspacesOptions extends CellOptions<typeof WorkspacesJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

/**
 * Collection of open workspaces.
 *
 * Manages the set of directories the daemon is watching and serving.
 * Each workspace has a unique path used as the index key.
 */
export class Workspaces extends Cell<typeof WorkspacesJson> {
	readonly items: IndexedCollection<Workspace> = new IndexedCollection({
		indexes: [
			create_single_index({
				key: 'by_path',
				extractor: (workspace) => workspace.path,
				query_schema: z.string(),
			}),
		],
	});

	active_id: Uuid | null = $state()!;

	readonly active: Workspace | undefined = $derived(
		this.active_id ? this.items.by_id.get(this.active_id) : undefined,
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
			},
		};

		this.init();
	}

	/**
	 * Add a workspace. If a workspace with the same path already exists, returns it.
	 */
	add(json: WorkspaceJsonInput): Workspace {
		const existing = this.get_by_path(json.path as DiskfileDirectoryPath);
		if (existing) return existing;

		const workspace = new Workspace({app: this.app, json});
		this.items.add(workspace);

		// Auto-activate if no active workspace
		if (this.active_id === null) {
			this.active_id = workspace.id;
		}

		return workspace;
	}

	remove(id: Uuid): void {
		this.items.remove(id);
		if (id === this.active_id) {
			const next = this.items.by_id.values().next();
			this.active_id = next.value?.id ?? null;
		}
	}

	get_by_path(path: DiskfileDirectoryPath): Workspace | undefined {
		return this.items.by_optional('by_path', path);
	}

	activate(id: Uuid): void {
		if (this.items.by_id.has(id)) {
			this.active_id = id;
		}
	}
}
