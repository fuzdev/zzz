import {
	object,
	type AnySchema,
	type Infer,
	type InferInput,
	type SchemaEntries
} from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { UuidWithDefault } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { DatetimeNow } from './datetime.ts';

declare module '@fuzdev/fuz_schema/meta.ts' {
	interface SchemaMeta {
		/** The name of the registered `Cell` class that a value of this schema instantiates. */
		cell_class_name?: string;
	}
}

/**
 * Get keys from a schema's output.
 */
export type SchemaKeys<T extends AnySchema> = keyof Infer<T> & string;

/**
 * Get value type for a specific key in a schema's output.
 */
export type SchemaValue<T extends AnySchema, K extends SchemaKeys<T>> = Infer<T>[K];

/**
 * Base schema that defines common properties for all cells.
 */
export const CellJson = object({
	id: UuidWithDefault,
	created: DatetimeNow,
	/** Required and initially equal to `created`. */
	updated: DatetimeNow
});
export type CellJson = Infer<typeof CellJson>;
export type CellJsonInput = InferInput<typeof CellJson>;

/**
 * The entries of a cell schema: `CellJson`'s, then `T`'s, a key of `T`
 * replacing `CellJson`'s.
 */
export type CellJsonEntries<T extends SchemaEntries> = Omit<typeof CellJson.def, keyof T> & T;

/**
 * Creates a cell's schema: `CellJson`'s entries then `entries` (a later key
 * overrides an earlier one in its position), as an `object`, with
 * `cell_class_name` metadata naming the registered class it instantiates.
 *
 * @param entries - the cell's own entries
 * @param cell_class_name - the registered `Cell` class name, its key in `cell_classes.ts`
 */
export const cell_json_schema = <T extends SchemaEntries>(
	entries: T,
	cell_class_name: string
): ReturnType<typeof object<CellJsonEntries<T>>> =>
	meta(object<CellJsonEntries<T>>({ ...CellJson.def, ...entries }), { cell_class_name });
