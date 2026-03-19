import {CONTENT_PREVIEW_LENGTH} from './constants.js';

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
	Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);

/** Creates an id suitable for insecure use on a single client, like for element ids. */
export const create_client_id = (): string => Math.random().toString(36).substring(2);

export const get_unique_name = (
	name: string,
	existing_names: {has: (name: string) => boolean} | {includes: (name: string) => boolean},
): string => {
	const check = (existing_names as any)['has' in existing_names ? 'has' : 'includes'].bind(
		existing_names,
	);
	let result = name;
	let i = 2;
	while (check(result)) {
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
	max_length: number = CONTENT_PREVIEW_LENGTH,
): string =>
	content ? (content.length > max_length ? content.substring(0, max_length) + '...' : content) : '';
