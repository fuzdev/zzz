import type { AnySchema, Infer, SchemaKind, SchemaNode } from '@fuzdev/fuz_schema/schema.ts';
import {
	get_schema_entries,
	get_schema_meta,
	unwrap_schema
} from '@fuzdev/fuz_schema/introspect.ts';

/** Sentinel value to indicate a parser has completely handled a property. */
export const HANDLED = Symbol('HANDLED_BY_PARSER');

// Constants for date formatting
export const FILE_SHORT_DATE_FORMAT = 'MMM d, p';
export const FILE_DATETIME_FORMAT = 'MMM d, yyyy h:mm:ss a';
export const FILE_TIME_FORMAT = 'HH:mm:ss';

/**
 * Schema class information extracted from a schema.
 */
export interface SchemaClassInfo {
	/** The `kind` of the schema under its wrappers. */
	kind: SchemaKind;
	is_array: boolean;
	class_name?: string;
	element_class?: string;
}

// A type helper that makes it easier to define value parsers with correct input types
export type ValueParser<
	TSchema extends AnySchema,
	TKey extends keyof Infer<TSchema> = keyof Infer<TSchema>
> = {
	[K in TKey]?: (value: unknown) => Infer<TSchema>[K] | undefined;
};

/**
 * Type helper for decoders that includes base schema properties.
 * Use this instead of `ValueParser` when creating decoders for cells
 * to properly type the base properties.
 */
export type CellValueDecoder<
	TSchema extends AnySchema,
	TKey extends keyof Infer<TSchema> = keyof Infer<TSchema>
> = {
	[K in TKey]?: (value: unknown) => Infer<TSchema>[K] | undefined | typeof HANDLED;
};

/**
 * Creates the decoder for a property that holds a collection of cells. An array
 * value replaces the collection's contents — `clear`, then `add` for each
 * element — and any other value leaves the collection unchanged. It always
 * returns `HANDLED`, so the property is never assigned the raw JSON.
 *
 * @param clear - empties the collection, disposing the items it owns
 * @param add - creates and adds the item for one element's JSON
 * @returns a decoder for `Cell.decoders`
 */
export const create_collection_decoder =
	// `any`, not a `TJson` generic — an unannotated `(json) => ...` gives `TJson`
	// no inference site, so it'd be `unknown` and every call site would need annotating
	(clear: () => void, add: (json: any) => unknown) =>
		(value: unknown): typeof HANDLED => {
			if (Array.isArray(value)) {
				clear();
				for (const json of value) {
					add(json);
				}
			}
			return HANDLED;
		};

/**
 * Get schema class information from a schema.
 * This helps determine how to decode values based on their schema definition.
 *
 * An array under the field's wrappers (`optional`, `nullable`, the defaults,
 * a `pipe`'s first schema, `lazy`) reports the `cell_class_name` of its
 * element. Otherwise `class_name` is the `cell_class_name` on the outermost
 * layer of the field that has one.
 */
export const get_schema_class_info = (
	schema: AnySchema | null | undefined
): SchemaClassInfo | null => {
	if (!schema) return null;

	// Unwrap to get the core schema
	const unwrapped = unwrap_schema(schema);

	if (unwrapped.kind === 'array') {
		return {
			kind: 'array',
			is_array: true,
			element_class: get_schema_meta(unwrapped.def, 'cell_class_name')
		};
	}

	const class_name = get_schema_meta(schema, 'cell_class_name');
	if (class_name) {
		return { kind: unwrapped.kind, class_name, is_array: false };
	}

	return { kind: unwrapped.kind, is_array: false };
};

/**
 * What `Cell` reads from its schema: the field schemas, their keys in order,
 * and each field's `SchemaClassInfo`. Shared by every cell of a schema,
 * so never mutate it.
 */
export interface CellSchemaIntrospection {
	field_schemas: ReadonlyMap<string, SchemaNode>;
	schema_keys: ReadonlyArray<string>;
	field_schema_info: ReadonlyMap<string, SchemaClassInfo | null>;
}

const cell_schema_introspections: WeakMap<AnySchema, CellSchemaIntrospection> = new WeakMap();

/**
 * Gets the `CellSchemaIntrospection` of `schema`, computed once per schema
 * object — a schema is immutable, so every cell built from it shares the result.
 */
export const get_cell_schema_introspection = (schema: AnySchema): CellSchemaIntrospection => {
	let introspection = cell_schema_introspections.get(schema);
	if (!introspection) {
		const field_schemas: Map<string, SchemaNode> = new Map(
			Object.entries(get_schema_entries(schema) ?? {})
		);
		const schema_keys = Array.from(field_schemas.keys());
		const field_schema_info: Map<string, SchemaClassInfo | null> = new Map(
			schema_keys.map((key) => [key, get_schema_class_info(field_schemas.get(key))])
		);
		introspection = { field_schemas, schema_keys, field_schema_info };
		cell_schema_introspections.set(schema, introspection);
	}
	return introspection;
};
