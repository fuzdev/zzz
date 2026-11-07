import {
	boolean,
	number,
	one_of,
	optional,
	string,
	with_default,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';

import { Cell, type CellOptions } from '#lib/cell.svelte.ts';
import { cell_json_schema } from '#lib/cell_types.ts';

// Browser tab schema with discriminated union for tab types
export const BrowserTabJson = cell_json_schema(
	{
		title: string,
		url: string,
		selected: with_default(boolean, false),
		refresh_counter: with_default(number, 0),
		type: one_of(['raw', 'embedded_html', 'external_url']),
		// Optional content field for embedded HTML tabs
		content: optional(string)
	},
	'BrowserTab'
);
export type BrowserTabJson = Infer<typeof BrowserTabJson>;
export type BrowserTabJsonInput = InferInput<typeof BrowserTabJson>;

export type BrowserTabOptions = CellOptions<typeof BrowserTabJson>;

/**
 * Represents a browser tab with different content types.
 * The tab behavior is determined by the `type` field:
 * - "raw": Shows raw content within the browser
 * - "embedded_html": Shows HTML content from the `content` field
 * - "external_url": Loads content from an external URL
 */
export class BrowserTab extends Cell<typeof BrowserTabJson> {
	title: string = $state.raw()!;
	url: string = $state.raw()!;
	selected: boolean = $state.raw()!;
	refresh_counter: number = $state.raw()!;
	type: 'raw' | 'embedded_html' | 'external_url' = $state.raw()!;
	content?: string = $state.raw();

	constructor(options: BrowserTabOptions) {
		super(BrowserTabJson, options);
		this.init();
	}

	refresh(): void {
		this.refresh_counter++;
	}
}
