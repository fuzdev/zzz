import {z} from 'zod';

import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {CellJson} from '$lib/cell_types.js';

// Browser tab schema with discriminated union for tab types
export const BrowserTabJson = CellJson.extend({
	title: z.string(),
	url: z.string(),
	selected: z.boolean().default(false),
	refresh_counter: z.number().default(0),
	type: z.enum(['raw', 'embedded_html', 'external_url']),
	// Optional content field for embedded HTML tabs
	content: z.string().optional(),
}).meta({cell_class_name: 'BrowserTab'});
export type BrowserTabJson = z.infer<typeof BrowserTabJson>;
export type BrowserTabJsonInput = z.input<typeof BrowserTabJson>;

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

export const BrowserTabSchema = z.instanceof(BrowserTab);
