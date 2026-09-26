import type { PartUnion } from './part.svelte.ts';
import { DISKFILE_CONTENT_NOT_LOADED_PLACEHOLDER } from './diskfile_helpers.ts';

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
 * A file part whose file content wasn't loaded (over 4 MiB, not UTF-8 text, or
 * unreadable) contributes `DISKFILE_CONTENT_NOT_LOADED_PLACEHOLDER` in its
 * place, so the prompt shows the file is missing rather than dropping it.
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

		// a file whose content wasn't loaded is marked, never silently dropped
		const content =
			part.type === 'diskfile' && part.content === null
				? DISKFILE_CONTENT_NOT_LOADED_PLACEHOLDER
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
