import { CONTENT_PREVIEW_LENGTH } from './constants.ts';

// TODO import from fuz_css (and respect prefers-reduced-motion? maybe optionally)
export const DURATION_LG = 1000;
export const DURATION_SM = 180;

// TODO configure
// this is a guesstimate, is lower to better estimate for code,
// and in general I think it's better better to overestimate counts (which lower does)
export const ESTIMATED_CHARS_PER_TOKEN = 3;

/**
 * Quick and dirty token count estimate using `ESTIMATED_CHARS_PER_TOKEN`.
 * Real tokenizers are heavy and of little benefit for our cases right now,
 * especially because each LLM may tokenize differently.
 */
export const estimate_token_count = (text: string): number =>
	estimate_token_count_from_length(text.length);

/**
 * `estimate_token_count` for a text of `length` characters, for callers that
 * know the length without building the text.
 */
export const estimate_token_count_from_length = (length: number): number =>
	Math.ceil(length / ESTIMATED_CHARS_PER_TOKEN);

// text, not an `icon_*` SVG from fuz_ui, because an attribute can't host markup
const PLACEHOLDER_GLYPH = '↳';

/**
 * Formats input `placeholder` text, prefixed with a `↳` arrow.
 * The arrow is a text glyph rather than an `icon_*` SVG
 * because the `placeholder` attribute can't host markup.
 */
export const format_placeholder = (text?: string | null): string =>
	text ? `${PLACEHOLDER_GLYPH} ${text}` : PLACEHOLDER_GLYPH;

/** Creates an id suitable for insecure use on a single client, like for element ids. */
export const create_client_id = (): string => Math.random().toString(36).substring(2);

/**
 * Returns `name`, or `name` suffixed with the lowest number from 2 up that
 * makes it unique among `existing_names`.
 *
 * @param name - the preferred name
 * @param existing_names - the taken names, like a `Set` or a `Map` keyed by name
 */
export const get_unique_name = (
	name: string,
	existing_names: { has: (name: string) => boolean }
): string => {
	let result = name;
	let i = 2;
	while (existing_names.has(result)) {
		result = `${name} ${i++}`;
	}
	return result;
};

export const defined = <T>(value: T | undefined): T => {
	if (value === undefined) {
		throw new Error('Value must be defined');
	}
	return value;
};

export const to_preview = (
	content: string | null | undefined,
	max_length: number = CONTENT_PREVIEW_LENGTH
): string =>
	content ? (content.length > max_length ? content.substring(0, max_length) + '...' : content) : '';
