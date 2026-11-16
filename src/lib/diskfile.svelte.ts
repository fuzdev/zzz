import { Cell, type CellOptions } from './cell.svelte.ts';
import {
	DiskfileDirectoryPath,
	DiskfileJson,
	type DiskfileContentStatus,
	type DiskfilePath,
	type DiskfileUnloadedReason,
	type DiskfileUnloadedStatus
} from './diskfile_types.ts';
import { to_preview } from './helpers.ts';
import type { PartUnion } from './part.svelte.ts';

// TODO support directories/folders

export interface DiskfileOptions extends CellOptions<typeof DiskfileJson> {}

export class Diskfile extends Cell<typeof DiskfileJson> {
	path: DiskfilePath = $state.raw()!;
	source_dir: DiskfileDirectoryPath = $state.raw()!;

	/** The file's text, `null` until it's loaded — see `content_status`. */
	content: string | null = $state.raw()!;

	/**
	 * Where the content stands while `content` is `null` — `content_status`
	 * then. Transient client state, not serialized; written by `Diskfiles`,
	 * which loads contents on demand (`Diskfiles.ensure_content`).
	 */
	unloaded_status: DiskfileUnloadedStatus = $state.raw('unrequested');

	/**
	 * Why a read found no text to load (over 4 MiB, not UTF-8). `null`
	 * otherwise, including for a read that failed (`content_error`).
	 */
	unloaded_reason: DiskfileUnloadedReason | null = $state.raw(null);

	/**
	 * The error of the last read that failed, `null` once one succeeds. A
	 * failed first read makes the file `unloadable`; a failed re-read keeps
	 * the content it had.
	 */
	content_error: string | null = $state.raw(null);

	/**
	 * Where the content stands: `loaded` whenever `content` holds it, else
	 * `unloaded_status` — not asked for yet, on its way, or not loadable. A
	 * loaded file stays `loaded` while it's read again after a change on disk,
	 * keeping its content until the new one lands.
	 */
	readonly content_status: DiskfileContentStatus = $derived(
		this.content !== null ? 'loaded' : this.unloaded_status
	);

	size: number | null = $state.raw()!;

	mtime: number | null = $state.raw()!;

	/**
	 * The file is gone from disk, but this diskfile is kept because a tab holds
	 * unsaved edits for it. Transient client state, not serialized — cleared
	 * when the path reappears on disk. Set it through
	 * `Diskfiles.set_deleted_on_disk`, which keeps the index's directories in step.
	 */
	deleted_on_disk: boolean = $state.raw(false);

	readonly part: PartUnion | undefined = $derived(
		this.app.parts.find_part_by_diskfile_path(this.path)
	);

	/** e.g. `bar/foo.json` inside the zzz dir, or an absolute path outside it. */
	readonly path_relative: string | null | undefined = $derived(
		this.app.diskfiles.to_relative_path(this.path)
	);

	/**
	 * Whether the file's content is loaded (`content_status`). While it isn't
	 * — not yet, or not loadable — `content` says nothing about what's on
	 * disk: the file can't be edited or saved over (see
	 * `to_diskfile_unloaded_message`).
	 */
	readonly content_loaded: boolean = $derived(this.content !== null);

	readonly content_preview: string = $derived(to_preview(this.content));

	constructor(options: DiskfileOptions) {
		super(DiskfileJson, options);
		this.init();
	}
}
