// @slop Claude Sonnet 4.5

import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DEV} from 'esm-env';

/**
 * Options for updating environment variables in a .env file.
 */
export interface UpdateEnvVariableOptions {
	/**
	 * Path to the .env file (defaults to `./.env`)
	 */
	env_file_path?: string;
	/**
	 * Function to read file contents (defaults to node:fs/promises readFile)
	 */
	read_file?: (path: string, encoding: string) => Promise<string>;
	/**
	 * Function to write file contents (defaults to node:fs/promises writeFile)
	 */
	write_file?: (path: string, content: string, encoding: string) => Promise<void>;
}

/**
 * Updates or adds an environment variable in the .env file.
 * Preserves existing formatting, comments, and other variables.
 *
 * Behavior:
 * - **Duplicate keys**: Updates the LAST occurrence (matches dotenv behavior)
 * - **Inline comments**: Preserved after the value (e.g., `KEY=value # comment`)
 * - **Quote style**: Preserved from original (quoted/unquoted)
 *
 * @param key - the environment variable name (e.g., 'SOME_CONFIGURATION_KEY')
 * @param value - the new value for the environment variable
 * @param options - optional configuration for file path and operations
 */
export async function update_env_variable(
	key: string,
	value: string,
	options: UpdateEnvVariableOptions = {},
): Promise<void> {
	const {
		env_file_path = DEV ? './.env.development' : './.env.production', // TODO hacky
		read_file = readFile,
		write_file = writeFile,
	} = options;

	const file_path = resolve(env_file_path);
	let content = '';

	// Read existing file if it exists
	try {
		content = await read_file(file_path, 'utf-8');
	} catch (error: any) {
		// File doesn't exist, use empty string (which is already the default)
		if (error?.code !== 'ENOENT') {
			throw error; // Re-throw if it's not a "file not found" error
		}
	}

	// Parse the file line by line
	const lines = content.split('\n');

	// Find the LAST occurrence of the key (matches dotenv "last wins" behavior)
	const last_match_idx = find_last_key_line_index(lines, key);

	const updated_lines = lines.map((line, idx) => {
		// Only update the last occurrence
		if (idx === last_match_idx) {
			const equals_pos = line.indexOf('=');
			const value_part = line.substring(equals_pos + 1);

			// Extract inline comment and determine quote style
			const inline_comment = extract_inline_comment(value_part);
			const trimmed_value = value_part.trim();
			const has_quotes = is_quoted_value(trimmed_value);

			return has_quotes ? `${key}="${value}"${inline_comment}` : `${key}=${value}${inline_comment}`;
		}
		return line;
	});

	// If key wasn't found, add it at the end
	if (last_match_idx === -1) {
		// Special case: if content was empty, don't add unnecessary line
		if (content === '') {
			await write_file(file_path, `${key}="${value}"`, 'utf-8');
			return;
		}

		// Just push the new key - join will handle newline separator
		// If file ended with newline, the existing empty string creates blank line
		// If file didn't end with newline, join adds the newline automatically
		updated_lines.push(`${key}="${value}"`);
	}

	// Write the updated content back
	const updated_content = updated_lines.join('\n');
	await write_file(file_path, updated_content, 'utf-8');
}

/**
 * Finds the index of the last occurrence of a key in the lines array.
 * Ignores empty lines and commented lines.
 *
 * @param lines - array of lines from the .env file
 * @param key - the key to search for
 * @returns index of the last matching line, or -1 if not found
 */
const find_last_key_line_index = (lines: Array<string>, key: string): number => {
	let last_match_idx = -1;

	lines.forEach((line, idx) => {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) return;

		const match = /^([^=]+)=/.exec(line);
		const matched_key = match?.[1];
		if (matched_key && matched_key.trim() === key) {
			last_match_idx = idx;
		}
	});

	return last_match_idx;
};

/**
 * Extracts inline comment from the value part of an env line.
 * Handles both quoted and unquoted values correctly.
 *
 * Examples:
 * - `"value" # comment` → ` # comment`
 * - `value # comment` → ` # comment`
 * - `"value#inside" # comment` → ` # comment` (# inside quotes is not a comment)
 * - `value#comment` → `#comment` (no space before # is still a comment)
 *
 * @param value_part - the part of the line after the `=` sign
 * @returns the inline comment including the `#` and any whitespace before it
 */
const extract_inline_comment = (value_part: string): string => {
	const trimmed_value = value_part.trim();

	if (is_quoted_value(trimmed_value)) {
		// Quoted value - find comment after closing quote
		const quote_char = trimmed_value[0];
		if (!quote_char) return '';
		let closing_quote_idx = trimmed_value.indexOf(quote_char, 1);

		// Handle escaped quotes by checking backslash count
		while (closing_quote_idx > 0 && is_quote_escaped(trimmed_value, closing_quote_idx)) {
			closing_quote_idx = trimmed_value.indexOf(quote_char, closing_quote_idx + 1);
		}

		if (closing_quote_idx !== -1) {
			const after_quote = trimmed_value.substring(closing_quote_idx + 1);
			const comment_match = /(\s*#.*)/.exec(after_quote);
			const captured_comment = comment_match?.[1];
			if (captured_comment) {
				return captured_comment;
			}
		}
	} else {
		// Unquoted value - comment starts at first #
		const comment_match = /(\s*#.*)/.exec(value_part);
		const captured_comment = comment_match?.[1];
		if (captured_comment) {
			return captured_comment;
		}
	}

	return '';
};

/**
 * Checks if a quote character at a specific position is escaped.
 * Counts consecutive backslashes before the quote:
 * - Odd number (1, 3, 5...): quote IS escaped
 * - Even number (0, 2, 4...): quote is NOT escaped
 *
 * @param str - the string containing the quote
 * @param quote_pos - the position of the quote to check
 * @returns `true` if the quote is escaped
 */
const is_quote_escaped = (str: string, quote_pos: number): boolean => {
	let backslash_count = 0;
	let pos = quote_pos - 1;

	// Count consecutive backslashes before the quote
	while (pos >= 0 && str[pos] === '\\') {
		backslash_count++;
		pos--;
	}

	// Odd number of backslashes means the quote is escaped
	return backslash_count % 2 === 1;
};

const QUOTE_CHARS = ['"', "'"] as const;

/**
 * Checks if a value string starts with a quote character.
 *
 * @param value - the trimmed value string to check
 * @returns `true` if the value starts with " or '
 */
const is_quoted_value = (value: string): boolean =>
	QUOTE_CHARS.some((char) => value.startsWith(char));
