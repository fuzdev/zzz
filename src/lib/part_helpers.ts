import type { SvgData } from '@fuzdev/fuz_ui/svg.ts';
import { icon_part, icon_file } from '@fuzdev/fuz_ui/icons.ts';

import type { DiskfilePart, PartUnion } from './part.svelte.ts';
import {
	DISKFILE_CONTENT_NOT_LOADED_MESSAGE,
	to_diskfile_unloaded_message
} from './diskfile_helpers.ts';
import type { Prompt } from './prompt.svelte.ts';
import type { Turn } from './turn.svelte.ts';

/**
 * What a part belongs to. A `Prompt` owns its part instances; a `Turn`
 * references parts in `app.parts`. Both remove through `remove_part`, which
 * disposes the part once nothing owns it.
 */
export type PartOwner = Prompt | Turn;

export const PART_ICONS = {
	text: icon_part,
	diskfile: icon_file
} satisfies Record<PartUnion['type'], SvgData>;

export const get_part_type_icon = (part: PartUnion): SvgData => PART_ICONS[part.type] ?? icon_part;

/**
 * Whether any of `parts` is a file part whose content is still on its way
 * (`unrequested` or `loading`) — so formatting them now would show
 * `DISKFILE_CONTENT_LOADING_PLACEHOLDER` in its place.
 */
export const are_parts_loading = (parts: Iterable<PartUnion>): boolean => {
	for (const part of parts) {
		if (
			part.type === 'diskfile' &&
			(part.content_status === 'unrequested' || part.content_status === 'loading')
		) {
			return true;
		}
	}
	return false;
};

/**
 * The file parts in `parts` whose file failed to read (`Diskfile.content_error`
 * on a file left `unloadable`) — unlike a file too large or not text, which is
 * sent as its marker (`to_part_not_loaded_marker`), a failed read that
 * `load_parts_content`'s retry doesn't recover stops a send (see
 * `Thread.send_message`).
 */
export const filter_failed_file_parts = (parts: Iterable<PartUnion>): Array<DiskfilePart> => {
	const failed: Array<DiskfilePart> = [];
	for (const part of parts) {
		if (
			part.type === 'diskfile' &&
			part.content_status === 'unloadable' &&
			part.diskfile?.content_error != null
		) {
			failed.push(part);
		}
	}
	return failed;
};

/**
 * Whether `load_parts_content` has reading to do for `parts`: a file part
 * still loading (`are_parts_loading`), or one whose read failed
 * (`filter_failed_file_parts`), which it reads once more.
 */
export const are_parts_pending_read = (parts: Iterable<PartUnion>): boolean => {
	const list = Array.from(parts);
	return are_parts_loading(list) || filter_failed_file_parts(list).length > 0;
};

/**
 * Loads the content of every file part `get_parts` gives for an explicit
 * ask — a send or a copy: what isn't loaded yet
 * (`DiskfilePart.ensure_content`), then each file whose read failed is read
 * once more (`Diskfiles.read_again`), so a transient error doesn't stick.
 * The parts are asked for again before the retry, so one removed meanwhile,
 * or in a turn disabled meanwhile, isn't read. What's sent or copied next
 * holds the files' text, or the marker of one that still can't load
 * (`to_part_not_loaded_marker`) — never a loading placeholder, nor a file
 * missing only because its read hadn't landed. `ensure_content` alone never
 * retries, since effects call it and would loop on a failure.
 * Never rejects.
 *
 * @param get_parts - the parts, asked for before the loads and again before
 * the retry
 * @param signal - once aborted, the failed reads aren't retried
 */
export const load_parts_content = async (
	get_parts: () => Iterable<PartUnion>,
	signal?: AbortSignal
): Promise<void> => {
	const loads: Array<Promise<void>> = [];
	for (const part of get_parts()) {
		if (part.type === 'diskfile') loads.push(part.ensure_content());
	}
	await Promise.all(loads);
	if (signal?.aborted) return;
	// `read_again` joins a read in flight, so a file several parts reference is read once
	const retries: Array<Promise<void>> = [];
	for (const part of filter_failed_file_parts(get_parts())) {
		if (part.diskfile) retries.push(part.app.diskfiles.read_again(part.diskfile));
	}
	await Promise.all(retries);
};

/**
 * What a send says when files it needs failed to read: each file once, with
 * its error, and how to send without them.
 *
 * @param failed - the parts, as `filter_failed_file_parts` gives them
 */
export const to_failed_file_parts_message = (failed: ReadonlyArray<DiskfilePart>): string => {
	const errors: Map<string, string> = new Map();
	for (const part of failed) {
		const error = part.diskfile?.content_error;
		if (part.path && error != null) errors.set(part.path, error);
	}
	const files = Array.from(errors, ([path, error]) => `${path}: ${error}`).join('; ');
	return failed.length === 1
		? `couldn't load ${files} — remove the part or disable its turn to send without it`
		: `couldn't load ${files} — remove the parts or disable their turns to send without them`;
};

/**
 * Why a file part's file can't load (over 4 MiB, not UTF-8 text, or
 * unreadable — `content_status` `unloadable`), as `to_diskfile_unloaded_message`
 * says it.
 *
 * @returns the message, `null` for any other part — a text part, a loaded
 * file, one still loading, or a part with no file at its path
 */
export const to_part_not_loaded_message = (part: PartUnion): string | null => {
	if (part.type !== 'diskfile' || part.content_status !== 'unloadable' || !part.diskfile) {
		return null;
	}
	return to_diskfile_unloaded_message(part.diskfile) ?? DISKFILE_CONTENT_NOT_LOADED_MESSAGE;
};

/**
 * What stands in for a file part's content where the file can't load: the
 * file's path and why (`to_part_not_loaded_message`), as in
 * `[/home/me/big.log: content not loaded — the file is over 4 MiB]`, so a
 * turn's text (`Turn.content`), and so a send or a copy, marks the file
 * instead of silently leaving it out. The path is named because a turn joins
 * its parts' text with no tag to carry it; it's `Diskfile.path_relative`, as
 * the XML `path` attribute has it — relative inside the app directory,
 * absolute elsewhere.
 *
 * @returns the marker, `null` for any other part
 */
export const to_part_not_loaded_marker = (part: PartUnion): string | null => {
	const message = to_part_not_loaded_message(part);
	if (message === null || part.type !== 'diskfile' || !part.diskfile) return null;
	const { diskfile } = part;
	return `[${diskfile.path_relative ?? diskfile.path}: ${message}]`;
};
