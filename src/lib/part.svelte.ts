import {
	array,
	boolean,
	literal,
	nullable,
	number,
	object,
	parse_or_throw,
	string,
	variant,
	with_default,
	with_default_fn,
	type AnySchema,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { EMPTY_OBJECT } from '@fuzdev/fuz_util/object.ts';
import { UnreachableError } from '@fuzdev/fuz_util/error.ts';
import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
import { type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { estimate_token_count } from './helpers.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { XmlAttributeWithDefaults } from './xml.ts';
import { CellJson } from './cell_types.ts';
import type { Diskfile } from './diskfile.svelte.ts';
import type { Frontend } from './frontend.svelte.ts';
import { DiskfilePath } from './diskfile_types.ts';
import { CONTENT_PREVIEW_LENGTH } from './constants.ts';

/** Common properties for all part types. */
export const PartJsonBase = object({
	...CellJson.def,
	type: string,
	name: with_default(string, ''),
	start: with_default(nullable(number), null),
	end: with_default(nullable(number), null),
	has_xml_tag: with_default(boolean, false),
	xml_tag_name: with_default(string, ''), // TODO @many move to the prompt somewhere
	attributes: with_default_fn(array(XmlAttributeWithDefaults), () => []), // TODO @many move to the prompt somewhere
	// TODO should maybe be swapped to `disabled`
	enabled: with_default(boolean, true),
	title: with_default(nullable(string), null),
	summary: with_default(nullable(string), null)
});
export type PartJsonBase = Infer<typeof PartJsonBase>;

/** Text part schema - direct content storage. */
export const TextPartJson = meta(
	object({
		...PartJsonBase.def,
		type: with_default(literal('text'), 'text'),
		content: with_default(string, '')
	}),
	{ cell_class_name: 'TextPart' }
);
export type TextPartJson = Infer<typeof TextPartJson>;
export type TextPartJsonInput = InferInput<typeof TextPartJson>;

/** Diskfile part schema - references a diskfile. */
export const DiskfilePartJson = meta(
	object({
		...PartJsonBase.def,
		type: with_default(literal('diskfile'), 'diskfile'),
		path: with_default(nullable(DiskfilePath), null),
		has_xml_tag: with_default(boolean, true) // Override to make true only for diskfiles
		// `content` is on disk at `path`, not in the serialized representation
	}),
	{ cell_class_name: 'DiskfilePart' }
);
export type DiskfilePartJson = Infer<typeof DiskfilePartJson>;
export type DiskfilePartJsonInput = InferInput<typeof DiskfilePartJson>;

/**
 * Union of all part types for deserialization, dispatched by `type`, which
 * must be present: each option's `type` is the bare literal, without the
 * default its part schema fills in.
 */
export const PartJson = variant('type', [
	object({ ...TextPartJson.def, type: literal('text') }),
	object({ ...DiskfilePartJson.def, type: literal('diskfile') })
]);
export type PartJson = Infer<typeof PartJson>;
export type PartJsonInput = InferInput<typeof PartJson>;

export type PartUnion = TextPart | DiskfilePart;
export type PartJsonType = TextPartJson | DiskfilePartJson;

export interface PartOptions<T extends AnySchema = typeof PartJsonBase> extends CellOptions<T> {
	json?: InferInput<T>;
}

export type TextPartOptions = PartOptions<typeof TextPartJson>;
export type DiskfilePartOptions = PartOptions<typeof DiskfilePartJson>;
export type PartOptionsUnion = TextPartOptions | DiskfilePartOptions;

/**
 * Abstract base class for all part types.
 */
export abstract class Part<T extends AnySchema = typeof PartJsonBase> extends Cell<T> {
	// The type discriminator - to be set by subclasses
	abstract readonly type: string;

	abstract get content(): string | null | undefined;

	start: number | null = $state.raw()!;
	end: number | null = $state.raw()!;
	readonly length: number | null | undefined = $derived.by(() => this.content?.length);
	readonly token_count: number | null | undefined = $derived.by(() =>
		this.content == null ? this.content : estimate_token_count(this.content)
	);
	/** `content` with a max length. */
	readonly content_preview = $derived.by(() =>
		this.content && this.content.length > CONTENT_PREVIEW_LENGTH
			? this.content.substring(0, CONTENT_PREVIEW_LENGTH)
			: this.content
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
		this.type === 'diskfile' ? 'File' : 'Fragment'
	);

	add_attribute(partial: InferInput<typeof XmlAttributeWithDefaults> = EMPTY_OBJECT): void {
		// TODO add with a default name
		this.attributes.push(parse_or_throw(XmlAttributeWithDefaults, partial));
	}

	/**
	 * @returns `true` if the attribute was updated, `false` if the attribute was not found
	 */
	update_attribute(
		id: Uuid,
		updates: Partial<OmitStrict<XmlAttributeWithDefaults, 'id'>>
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
		options?: DiskfilePartOptions
	): DiskfilePart;
	static create(app: Frontend, json: PartJsonInput, options?: PartOptionsUnion): PartUnion;
	static create(
		app: Frontend,
		json: TextPartJsonInput | DiskfilePartJsonInput,
		options?: PartOptionsUnion
	): PartUnion {
		if (!json.type) {
			throw new Error('Missing required "type" field in part JSON');
		}

		switch (json.type) {
			case 'text':
				return new TextPart({ ...options, app, json });
			case 'diskfile':
				return new DiskfilePart({ ...options, app, json });
			default:
				throw new UnreachableError(json.type);
		}
	}
}

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
				value: relative_path
			});
		}
	}

	/**
	 * The diskfile at `path`. One deleted on disk counts as missing unless it
	 * has a draft — then it's kept for the draft (see `Diskfiles.remove_by_path`),
	 * which the part shows and sends.
	 */
	readonly diskfile: Diskfile | null | undefined = $derived.by(() => {
		if (!this.path) return null;
		const diskfile = this.app.diskfiles.get_by_path(this.path);
		if (!diskfile?.deleted_on_disk) return diskfile;
		return this.app.diskfiles.find_editor_state(diskfile.id)?.has_unsaved_edits
			? diskfile
			: undefined;
	});

	/**
	 * How `content` relates to the disk: `'unsaved'` when it's the file's
	 * draft, `'conflict'` when that draft predates a change on disk,
	 * `'deleted'` when the file is gone from disk and only the draft remains,
	 * else `null` (the disk content).
	 */
	readonly draft_status: 'unsaved' | 'conflict' | 'deleted' | null = $derived.by(() => {
		const { diskfile } = this;
		if (!diskfile) return null;
		const editor_state = this.app.diskfiles.find_editor_state(diskfile.id);
		if (!editor_state?.has_unsaved_edits) return null;
		if (diskfile.deleted_on_disk) return 'deleted';
		return editor_state.disk_conflict ? 'conflict' : 'unsaved';
	});

	// The current relative path value for display in the XML path attribute
	readonly relative_path = $derived(this.diskfile?.path_relative);

	/**
	 * The file's draft if it has one (`draft_status` says so), else its disk
	 * content — never merely an older history entry an editor is viewing.
	 * Read-only: the part never writes to disk. Edits go through the file's
	 * `DiskfileEditorState`, whose `save_changes` reports failures.
	 *
	 * `undefined` when there's no file at `path`, `null` when the file's
	 * content wasn't loaded (`Diskfile.content_loaded`) — never an editor's
	 * empty text, so an unloaded file can't pass for an empty one.
	 */
	override get content(): string | null | undefined {
		const { diskfile } = this;
		if (!diskfile) return undefined;
		if (!diskfile.content_loaded) return null;
		return (
			this.app.diskfiles.find_editor_state(diskfile.id)?.history.draft_entry?.content ??
			diskfile.content
		);
	}

	constructor(options: DiskfilePartOptions) {
		super(DiskfilePartJson, options);
		this.init();
	}
}
