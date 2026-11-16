import type { SvgData } from '@fuzdev/fuz_ui/svg.ts';
import { icon_part, icon_file } from '@fuzdev/fuz_ui/icons.ts';

import type { DiskfilePart, PartUnion } from './part.svelte.ts';
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
 * Loads the content of every file part in `parts` that isn't
 * (`DiskfilePart.ensure_content`), so what's sent or copied next holds the
 * files' text — never a loading placeholder, nor a file missing only because
 * its read hadn't landed.
 * Never rejects.
 */
export const ensure_parts_content = async (parts: Iterable<PartUnion>): Promise<void> => {
	const loads: Array<Promise<void>> = [];
	for (const part of parts) {
		if (part.type === 'diskfile') loads.push(part.ensure_content());
	}
	await Promise.all(loads);
};

/**
 * The first file part in `parts` whose file failed to read
 * (`Diskfile.content_error` on a file left `unloadable`) — unlike a file too
 * large or not text, which is left out of what's sent, a failed read stops
 * a send (see `Thread.send_message`).
 */
export const find_failed_file_part = (parts: Iterable<PartUnion>): DiskfilePart | undefined => {
	for (const part of parts) {
		if (
			part.type === 'diskfile' &&
			part.content_status === 'unloadable' &&
			part.diskfile?.content_error != null
		) {
			return part;
		}
	}
	return undefined;
};
