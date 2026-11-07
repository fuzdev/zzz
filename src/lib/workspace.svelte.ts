import {
	object,
	one_of,
	string,
	with_default,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';

import { type Datetime } from './datetime.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import { DiskfileDirectoryPath } from './diskfile_types.ts';

// TODO: per-workspace state — open tabs, active chats, terminal presets (needs DB)
// TODO: workspace settings/config (e.g. default model, prompt templates)

/**
 * The wire format for workspace info shared between frontend and backend.
 * Used in action spec inputs/outputs and for JSON persistence.
 */
// TODO: include id in WorkspaceInfoJson so frontend and backend share the same workspace identity instead of regenerating UUIDs on each sync
export const WorkspaceInfoJson = object({
	/** Absolute directory path for this workspace. */
	path: DiskfileDirectoryPath,
	/** Display name, auto-derived from directory basename. */
	name: string,
	/** ISO timestamp of when this workspace was opened. */
	opened_at: string
});
export type WorkspaceInfoJson = Infer<typeof WorkspaceInfoJson>;

/**
 * Whether every directory of an open workspace has a file watch. `degraded`
 * means the OS ran out of watches (inotify's `max_user_watches`), no watcher
 * could be created, or the directory went missing: the directories without a
 * watch are rescanned every few seconds, so their changes show up late.
 */
export const WorkspaceWatchStatus = one_of(['full', 'degraded']);
export type WorkspaceWatchStatus = Infer<typeof WorkspaceWatchStatus>;

export const WorkspaceJson = cell_json_schema(
	{
		path: DiskfileDirectoryPath,
		name: with_default(string, ''),
		opened_at: with_default(string, '')
	},
	'Workspace'
);
export type WorkspaceJson = Infer<typeof WorkspaceJson>;
export type WorkspaceJsonInput = InferInput<typeof WorkspaceJson>;

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
