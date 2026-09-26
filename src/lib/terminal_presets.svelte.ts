import { z } from 'zod';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import {
	TerminalPreset,
	TerminalPresetJson,
	type TerminalPresetJsonInput
} from './terminal_preset.svelte.ts';
import { create_collection_decoder } from './cell_helpers.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { CellJson } from './cell_types.ts';

/** The presets a `TerminalPresets` starts with when constructed without `items`. */
export const TERMINAL_PRESETS_DEFAULT: ReadonlyArray<TerminalPresetJsonInput> = [
	{ name: 'echo hello world', command: 'echo', args: ['hello', 'world'] },
	{ name: 'check', command: 'gro', args: ['check'] },
	{ name: 'build', command: 'gro', args: ['build'] },
	{ name: 'dev', command: 'gro', args: ['dev'] }
];

export const TerminalPresetsJson = CellJson.extend({
	items: z.array(TerminalPresetJson).default(() => [])
}).meta({ cell_class_name: 'TerminalPresets' });
export type TerminalPresetsJson = z.infer<typeof TerminalPresetsJson>;
export type TerminalPresetsJsonInput = z.input<typeof TerminalPresetsJson>;

export interface TerminalPresetsOptions extends CellOptions<typeof TerminalPresetsJson> {}

/**
 * App-level collection of saved terminal commands. Seeded once with
 * `TERMINAL_PRESETS_DEFAULT` unless constructed with `items`.
 *
 * TODO persist user-created presets — they last only as long as the page
 */
export class TerminalPresets extends Cell<typeof TerminalPresetsJson> {
	readonly items: IndexedCollection<TerminalPreset> = new IndexedCollection({
		dispose_item: (preset) => preset.dispose()
	});

	constructor(options: TerminalPresetsOptions) {
		super(TerminalPresetsJson, options);

		this.decoders = {
			items: create_collection_decoder(
				() => this.clear(),
				(json) => this.add(json)
			)
		};

		this.init();

		if (options.json?.items === undefined) {
			for (const json of TERMINAL_PRESETS_DEFAULT) {
				this.add(json);
			}
		}
	}

	add(json?: TerminalPresetJsonInput): TerminalPreset {
		const preset = new TerminalPreset({ app: this.app, json });
		this.items.add(preset);
		return preset;
	}

	/**
	 * Removes and disposes a preset.
	 *
	 * @returns whether the preset was found
	 */
	remove(id: Uuid): boolean {
		return this.items.remove(id);
	}

	/**
	 * Removes and disposes every preset.
	 */
	clear(): void {
		this.items.clear();
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}
}
