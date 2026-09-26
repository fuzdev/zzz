import type { PartUnion } from './part.svelte.ts';
import { DISKFILE_CONTENT_NOT_LOADED_PLACEHOLDER } from './diskfile_helpers.ts';

/**
 * Formats a collection of parts into a prompt string,
 * applying XML tags and attributes where specified.
 *
 * A file part whose file content wasn't loaded (over 4 MiB, not UTF-8 text, or
 * unreadable) contributes `DISKFILE_CONTENT_NOT_LOADED_PLACEHOLDER` in its
 * place, so the prompt shows the file is missing rather than dropping it.
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
		formatted_contents.push(`<${xml_tag_name}${attrs}>\n${content}\n</${xml_tag_name}>`);
	}

	return formatted_contents.join('\n\n');
};
