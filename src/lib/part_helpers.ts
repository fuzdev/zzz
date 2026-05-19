import type {PartUnion} from './part.svelte.js';
import {GLYPH_PART, GLYPH_FILE} from './glyphs.js';

export const PART_GLYPHS = {
	text: GLYPH_PART,
	diskfile: GLYPH_FILE,
} satisfies Record<PartUnion['type'], string>;

export const get_part_type_glyph = (part: PartUnion): string =>
	PART_GLYPHS[part.type] ?? GLYPH_PART;
