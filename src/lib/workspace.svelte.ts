import { z } from 'zod';
import type { Datetime } from '@fuzdev/fuz_util/datetime.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';
import { DiskfileDirectoryPath } from './diskfile_types.ts';

// TODO: per-workspace state — open tabs, active chats, terminal presets (needs DB)
// TODO: workspace settings/config (e.g. default model, prompt templates)

/**
 * The wire format for workspace info shared between frontend and backend.
 * Used in action spec inputs/outputs and for JSON persistence.
 */
// TODO: include id in WorkspaceInfoJson so frontend and backend share the same workspace identity instead of regenerating UUIDs on each sync
export const WorkspaceInfoJson = z.strictObject({
	/** Absolute directory path for this workspace. */
	path: DiskfileDirectoryPath,
	/** Display name, auto-derived from directory basename. */
	name: z.string(),
	/** ISO timestamp of when this workspace was opened. */
	opened_at: z.string()
});
export type WorkspaceInfoJson = z.infer<typeof WorkspaceInfoJson>;

/**
 * Whether every directory of an open workspace has a file watch. `degraded`
 * means the OS ran out of watches (inotify's `max_user_watches`), no watcher
 * could be created, or the directory went missing: the directories without a
 * watch are rescanned every few seconds, so their changes show up late.
 */
export const WorkspaceWatchStatus = z.enum(['full', 'degraded']);
export type WorkspaceWatchStatus = z.infer<typeof WorkspaceWatchStatus>;

export const WorkspaceJson = CellJson.extend({
	path: DiskfileDirectoryPath,
	name: z.string().default(''),
	opened_at: z.string().default('')
}).meta({ cell_class_name: 'Workspace' });
export type WorkspaceJson = z.infer<typeof WorkspaceJson>;
export type WorkspaceJsonInput = z.input<typeof WorkspaceJson>;

export interface WorkspaceOptions extends CellOptions<typeof WorkspaceJson> {}

/**
 * A workspace represents an open directory that zzz is watching and serving.
 *
 * Workspaces are the primary unit of file access — each workspace registers
 * its directory with ScopedFs and starts a Filer for file watching.
 */
export class Workspace extends Cell<typeof WorkspaceJson> {
	path: DiskfileDirectoryPath = $state.raw()!;
	name: string = $state.raw()!;
	opened_at: Datetime = $state.raw()!;

	/**
	 * Whether the daemon watches every directory of this workspace, as of the
	 * last `workspace_open` — `degraded` means some are only rescanned
	 * periodically. Transient client state, not serialized.
	 */
	watch_status: WorkspaceWatchStatus = $state.raw('full');

	constructor(options: WorkspaceOptions) {
		super(WorkspaceJson, options);
		this.init();
	}
}
