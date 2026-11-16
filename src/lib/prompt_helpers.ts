import type { PartUnion } from './part.svelte.ts';
import { DISKFILE_CONTENT_LOADING_PLACEHOLDER } from './diskfile_helpers.ts';
import { to_part_not_loaded_marker, to_part_not_loaded_message } from './part_helpers.ts';

/**
 * The XML attributes `format_prompt_content` sets on a file part's tag to say
 * it sends an unsaved draft. While it does, a user attribute with one of these
 * keys is left out, so the tag never says both; a file part sending the disk
 * content keeps the user's.
 */
export const DISKFILE_PART_STATUS_ATTRIBUTES: ReadonlySet<string> = new Set([
	'unsaved',
	'changed_on_disk',
	'deleted_on_disk'
]);

/**
 * Formats a collection of parts into a prompt string,
 * applying XML tags and attributes where specified.
 *
 * A file part whose file content can't be loaded (over 4 MiB, not UTF-8 text,
 * or unreadable) is marked rather than dropped, so the omission is visible —
 * to the user in the preview and copied text, and to a model: inside its XML
 * tag, why in brackets (`to_part_not_loaded_message`, as in `[content not
 * loaded — the file is over 4 MiB]`); without a tag, the marker naming the
 * file too (`to_part_not_loaded_marker`), as in `Turn.content`. One whose
 * content is still on its way contributes `DISKFILE_CONTENT_LOADING_PLACEHOLDER`
 * — fine for a preview, so what sends or copies the result awaits
 * `load_parts_content` first (`Prompt.load_content`).
 *
 * A file part sends the file's unsaved draft when it has one
 * (`DiskfilePart.draft_status`); its XML tag then says so with `unsaved="true"`,
 * plus `changed_on_disk="true"` when the draft predates a change on disk or
 * `deleted_on_disk="true"` when the file is gone — so the model isn't told
 * an unsaved buffer is the file on disk. Those keys then replace any user
 * attribute of the same name (`DISKFILE_PART_STATUS_ATTRIBUTES`).
 */
export const format_prompt_content = (parts: Array<PartUnion>): string => {
	const formatted_contents = [];

	for (const part of parts) {
		if (!part.enabled) continue;

		// a file whose content isn't loaded is marked, never silently dropped
		const not_loaded = to_part_not_loaded_message(part);
		const content =
			not_loaded !== null
				? part.has_xml_tag
					? `[${not_loaded}]`
					: to_part_not_loaded_marker(part)
				: part.type === 'diskfile' && part.content === null
					? DISKFILE_CONTENT_LOADING_PLACEHOLDER
					: part.content?.trim();
		if (!content) continue;

		if (!part.has_xml_tag) {
			formatted_contents.push(content);
			continue;
		}

		const xml_tag_name = part.xml_tag_name.trim() || part.xml_tag_name_default;

		// Build attributes string
		let attrs = '';
		for (const attr of part.attributes) {
			// Safely handle key which might be null (in tests) but should be string in production
			const trimmed_key = attr.key?.trim() || '';
			// the automatic status attributes win over a user attribute with the same key
			if (
				part.type === 'diskfile' &&
				part.draft_status &&
				DISKFILE_PART_STATUS_ATTRIBUTES.has(trimmed_key)
			) {
				continue;
			}
			if (trimmed_key) {
				if (attr.value === '') {
					// Handle boolean attributes (just the key)
					attrs += ` ${trimmed_key}`;
				} else {
					// Handle regular attributes with values
					attrs += ` ${trimmed_key}="${attr.value}"`;
				}
			}
		}
		if (part.type === 'diskfile' && part.draft_status) {
			attrs += ' unsaved="true"';
			if (part.draft_status === 'conflict') attrs += ' changed_on_disk="true"';
			if (part.draft_status === 'deleted') attrs += ' deleted_on_disk="true"';
		}
		formatted_contents.push(`<${xml_tag_name}${attrs}>\n${content}\n</${xml_tag_name}>`);
	}

	return formatted_contents.join('\n\n');
};
