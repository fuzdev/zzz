import {z} from 'zod';
import {EMPTY_OBJECT} from '@fuzdev/fuz_util/object.js';
import {DEV} from 'esm-env';
import {UnreachableError} from '@fuzdev/fuz_util/error.js';
import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

import {estimate_token_count} from './helpers.js';
import {Cell, type CellOptions} from './cell.svelte.js';
import {Uuid} from './zod_helpers.js';
import {XmlAttributeWithDefaults} from './xml.js';
import {CellJson} from './cell_types.js';
import type {Diskfile} from './diskfile.svelte.js';
import type {Frontend} from './frontend.svelte.js';
import {DiskfilePath} from './diskfile_types.js';
import {CONTENT_PREVIEW_LENGTH} from './constants.js';

/** Common properties for all part types. */
export const PartJsonBase = CellJson.extend({
	type: z.string(),
	name: z.string().default(''),
	start: z.number().nullable().default(null),
	end: z.number().nullable().default(null),
	has_xml_tag: z.boolean().default(false),
	xml_tag_name: z.string().default(''), // TODO @many move to the prompt somewhere
	attributes: z.array(XmlAttributeWithDefaults).default(() => []), // TODO @many move to the prompt somewhere
	// TODO should maybe be swapped to `disabled`
	enabled: z.boolean().default(true),
	title: z.string().nullable().default(null),
	summary: z.string().nullable().default(null),
});
export type PartJsonBase = z.infer<typeof PartJsonBase>;

/** Text part schema - direct content storage. */
export const TextPartJson = PartJsonBase.extend({
	type: z.literal('text').default('text'),
	content: z.string().default(''),
});
export type TextPartJson = z.infer<typeof TextPartJson>;
export type TextPartJsonInput = z.input<typeof TextPartJson>;

/** Diskfile part schema - references a diskfile. */
export const DiskfilePartJson = PartJsonBase.extend({
	type: z.literal('diskfile').default('diskfile'),
	path: DiskfilePath.nullable().default(null),
	has_xml_tag: PartJsonBase.shape.has_xml_tag.default(true), // Override to make true only for diskfiles
	// `content` is on disk at `path`, not in the serialized representation
});
export type DiskfilePartJson = z.infer<typeof DiskfilePartJson>;
export type DiskfilePartJsonInput = z.input<typeof DiskfilePartJson>;

/** Union of all part types for deserialization. */
export const PartJson = z
	.discriminatedUnion('type', [TextPartJson, DiskfilePartJson])
	.meta({cell_class_name: 'Part'});
export type PartJson = z.infer<typeof PartJson>;
export type PartJsonInput = z.input<typeof PartJson>;

export type PartUnion = TextPart | DiskfilePart;
export type PartJsonType = TextPartJson | DiskfilePartJson;

export interface PartOptions<T extends z.ZodType = typeof PartJsonBase> extends CellOptions<T> {
	json?: z.input<T>;
}

export type TextPartOptions = PartOptions<typeof TextPartJson>;
export type DiskfilePartOptions = PartOptions<typeof DiskfilePartJson>;
export type PartOptionsUnion = TextPartOptions | DiskfilePartOptions;

/**
 * Abstract base class for all part types.
 */
export abstract class Part<T extends z.ZodType = typeof PartJsonBase> extends Cell<T> {
	// The type discriminator - to be set by subclasses
	abstract readonly type: string;

	abstract get content(): string | null | undefined;

	start: number | null = $state.raw()!;
	end: number | null = $state.raw()!;
	readonly length: number | null | undefined = $derived.by(() => this.content?.length);
	readonly token_count: number | null | undefined = $derived.by(() =>
		this.content == null ? this.content : estimate_token_count(this.content),
	);
	/** `content` with a max length. */
	readonly content_preview = $derived.by(() =>
		this.content && this.content.length > CONTENT_PREVIEW_LENGTH
			? this.content.substring(0, CONTENT_PREVIEW_LENGTH)
			: this.content,
	);

	// TODO rethink these patterns, see A2A Parts
	// Common properties for all part types
	name: string = $state.raw()!;
	has_xml_tag: boolean = $state.raw()!;
	xml_tag_name: string = $state.raw()!;
	attributes: Array<XmlAttributeWithDefaults> = $state()!; // TODO if kept, name `xml_attributes`?
	enabled: boolean = $state.raw()!;
	title: string | null = $state.raw()!;
	summary: string | null = $state.raw()!;

	readonly xml_tag_name_default: string = $derived.by(() =>
		this.type === 'diskfile' ? 'File' : 'Fragment',
	);

	add_attribute(partial: z.input<typeof XmlAttributeWithDefaults> = EMPTY_OBJECT): void {
		// TODO add with a default name
		this.attributes.push(XmlAttributeWithDefaults.parse(partial));
	}

	/**
	 * @returns `true` if the attribute was updated, `false` if the attribute was not found
	 */
	update_attribute(
		id: Uuid,
		updates: Partial<OmitStrict<XmlAttributeWithDefaults, 'id'>>,
	): boolean {
		// Find the attribute by id
		const index = this.attributes.findIndex((a) => a.id === id);
		if (index === -1) return false;

		// TODO refactor this code, maybe update directly? using svelte 5 idioms
		const new_attributes = [...this.attributes];

		const attr = new_attributes[index]!; // guaranteed by index !== -1 check above

		if ('key' in updates && updates.key !== undefined) {
			attr.key = updates.key;
		}

		if ('value' in updates && updates.value !== undefined) {
			attr.value = updates.value;
		}

		this.attributes = new_attributes;

		return true;
	}

	remove_attribute(id: Uuid): void {
		const index = this.attributes.findIndex((a) => a.id === id);
		if (index !== -1) {
			this.attributes.splice(index, 1);
		}
	}

	static create(app: Frontend, json: TextPartJsonInput, options?: TextPartOptions): TextPart;
	static create(
		app: Frontend,
		json: DiskfilePartJsonInput,
		options?: DiskfilePartOptions,
	): DiskfilePart;
	static create(app: Frontend, json: PartJsonInput, options?: PartOptionsUnion): PartUnion;
	static create(app: Frontend, json: PartJsonInput, options?: PartOptionsUnion): PartUnion {
		if (!json.type) {
			throw new Error('Missing required "type" field in part JSON');
		}

		switch (json.type) {
			case 'text':
				return new TextPart({...options, app, json});
			case 'diskfile':
				return new DiskfilePart({...options, app, json});
			default:
				throw new UnreachableError(json.type);
		}
	}
}

export const PartSchema = z.instanceof(Part);

/**
 * Text part - stores content directly.
 */
export class TextPart extends Part<typeof TextPartJson> {
	override readonly type = 'text';

	override content: string = $state.raw()!;

	constructor(options: TextPartOptions) {
		super(TextPartJson, options);
		this.init();
	}
}

export const TextPartSchema = z.instanceof(TextPart);

/**
 * Diskfile part - references content from a Diskfile.
 */
export class DiskfilePart extends Part<typeof DiskfilePartJson> {
	override readonly type = 'diskfile';

	/** Path property with private backing field. */
	#path: DiskfilePath | null = $state.raw()!;

	/**
	 * Writable value that determines `this.diskfile`.
	 * Also includes special diskfile part logic for attributes.
	 */
	get path(): DiskfilePath | null {
		return this.#path;
	}

	set path(value: DiskfilePath | null) {
		this.#path = value;

		if (value === null) return;

		// Update the path attribute when the path changes
		const diskfile = this.app.diskfiles.get_by_path(value);
		const relative_path = diskfile?.path_relative;

		if (!relative_path) return;

		// Check if a path attribute already exists
		const path_attr_index = this.attributes.findIndex((attr) => attr.key.trim() === 'path');

		if (path_attr_index >= 0) {
			// Update existing path attribute
			const new_attributes = [...this.attributes];
			new_attributes[path_attr_index]!.value = relative_path; // guaranteed by >= 0 check
			this.attributes = new_attributes;
		} else {
			// Add new path attribute
			this.add_attribute({
				key: 'path',
				value: relative_path,
			});
		}
	}

	// Reference to the editor state for this part
	#editor_state: {current_content: string} | null = $state(null); // TODO @many this initialization is awkward, ideally becomes refactored to mostly derived

	readonly diskfile: Diskfile | null | undefined = $derived(
		this.path && this.app.diskfiles.get_by_path(this.path),
	);

	// The current relative path value for display in the XML path attribute
	readonly relative_path = $derived(this.diskfile?.path_relative);

	override get content(): string | null | undefined {
		// Return editor content if available, otherwise fall back to diskfile content
		return this.#editor_state?.current_content ?? this.diskfile?.content; // TODO @many this initialization is awkward, ideally becomes refactored to mostly derived
	}

	set content(value: string | null | undefined) {
		if (value == null) {
			if (DEV) console.error(`Cannot set diskfile content to ${value}`);
			return;
		}

		if (this.path) {
			void this.app.diskfiles.update(this.path, value);
		}
	}

	constructor(options: DiskfilePartOptions) {
		super(DiskfilePartJson, options);
		this.init();
	}

	// TODO @many this initialization is awkward, ideally becomes refactored to mostly derived
	/**
	 * Links this part to an editor state.
	 */
	link_editor_state(editor_state: {current_content: string} | null): void {
		this.#editor_state = editor_state;
	}
}

export const DiskfilePartSchema = z.instanceof(DiskfilePart);
