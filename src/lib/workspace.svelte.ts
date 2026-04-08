import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';
import {DiskfileDirectoryPath} from './diskfile_types.js';
import type {Datetime} from './zod_helpers.js';

// TODO: per-workspace state — open tabs, active chats, terminal presets (needs DB)
// TODO: workspace settings/config (e.g. default model, prompt templates)

/**
 * The wire format for workspace info shared between frontend and backend.
 * Used in action spec inputs/outputs and for JSON persistence.
 */
export const WorkspaceInfoJson = z.strictObject({
	/** Absolute directory path for this workspace. */
	path: DiskfileDirectoryPath,
	/** Display name, auto-derived from directory basename. */
	name: z.string(),
	/** ISO timestamp of when this workspace was opened. */
	opened_at: z.string(),
});
export type WorkspaceInfoJson = z.infer<typeof WorkspaceInfoJson>;

export const WorkspaceJson = CellJson.extend({
	path: DiskfileDirectoryPath,
	name: z.string().default(''),
	opened_at: z.string().default(''),
}).meta({cell_class_name: 'Workspace'});
export type WorkspaceJson = z.infer<typeof WorkspaceJson>;
export type WorkspaceJsonInput = z.input<typeof WorkspaceJson>;

export interface WorkspaceOptions extends CellOptions<typeof WorkspaceJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

/**
 * A workspace represents an open directory that zzz is watching and serving.
 *
 * Workspaces are the primary unit of file access — each workspace registers
 * its directory with ScopedFs and starts a Filer for file watching.
 */
export class Workspace extends Cell<typeof WorkspaceJson> {
	path: DiskfileDirectoryPath = $state()!;
	name: string = $state()!;
	opened_at: Datetime = $state()!;

	constructor(options: WorkspaceOptions) {
		super(WorkspaceJson, options);
		this.init();
	}
}
