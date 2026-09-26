import { z } from 'zod';
import { zod_get_innermost_type } from '@fuzdev/fuz_util/zod.ts';

/** Sentinel value to indicate a parser has completely handled a property. */
export const HANDLED = Symbol('HANDLED_BY_PARSER');

// Constants for date formatting
export const FILE_SHORT_DATE_FORMAT = 'MMM d, p';
export const FILE_DATETIME_FORMAT = 'MMM d, yyyy h:mm:ss a';
export const FILE_TIME_FORMAT = 'HH:mm:ss';

/**
 * Schema class information extracted from a Zod schema.
 */
export interface SchemaClassInfo {
	type: string;
	is_array: boolean;
	class_name?: string;
	element_class?: string;
}

// A type helper that makes it easier to define value parsers with correct input types
export type ValueParser<
	TSchema extends z.ZodType,
	TKey extends keyof z.infer<TSchema> = keyof z.infer<TSchema>
> = {
	[K in TKey]?: (value: unknown) => z.infer<TSchema>[K] | undefined;
};

/**
 * Type helper for decoders that includes base schema properties.
 * Use this instead of `ValueParser` when creating decoders for cells
 * to properly type the base properties.
 */
export type CellValueDecoder<
	TSchema extends z.ZodType,
	TKey extends keyof z.infer<TSchema> = keyof z.infer<TSchema>
> = {
	[K in TKey]?: (value: unknown) => z.infer<TSchema>[K] | undefined | typeof HANDLED;
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
 * Get schema class information from a Zod schema.
 * This helps determine how to decode values based on their schema definition.
 */
export const get_schema_class_info = (
	schema: z.ZodType | null | undefined
): SchemaClassInfo | null => {
	if (!schema) return null;

	// Unwrap to get the core schema
	const unwrapped = zod_get_innermost_type(schema);

	// Handle ZodArray
	if (unwrapped instanceof z.ZodArray) {
		// Get class name from element schema's metadata
		// TODO temporary bug: https://github.com/typescript-eslint/typescript-eslint/issues/11666

		const element_meta = (unwrapped.element as z.ZodType).meta?.();
		const element_class = element_meta?.cell_class_name as string | undefined;
		return {
			type: 'ZodArray',
			is_array: true,
			element_class
		};
	}

	// Get class name from schema metadata if present for any schema type
	// TODO temporary bug: https://github.com/typescript-eslint/typescript-eslint/issues/11666

	const meta = schema.meta?.();
	if (meta?.cell_class_name) {
		return {
			type: unwrapped.constructor.name,
			class_name: meta.cell_class_name as string,
			is_array: false
		};
	}

	// Handle other specific types
	if (unwrapped instanceof z.ZodMap) {
		return { type: 'ZodMap', is_array: false };
	}
	if (unwrapped instanceof z.ZodSet) {
		return { type: 'ZodSet', is_array: false };
	}

	// Default case for any other schema type
	return { type: unwrapped.constructor.name, is_array: false };
};
