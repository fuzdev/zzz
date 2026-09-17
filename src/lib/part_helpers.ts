import type { SvgData } from '@fuzdev/fuz_ui/svg.ts';
import { icon_part, icon_file } from '@fuzdev/fuz_ui/icons.ts';

import type { PartUnion } from './part.svelte.ts';

export const PART_ICONS = {
	text: icon_part,
	diskfile: icon_file
} satisfies Record<PartUnion['type'], SvgData>;

export const get_part_type_icon = (part: PartUnion): SvgData => PART_ICONS[part.type] ?? icon_part;
