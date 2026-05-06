import {z} from 'zod';
import {UuidWithDefault} from '@fuzdev/fuz_util/id.js';
import {DatetimeNow} from '@fuzdev/fuz_util/datetime.js';

/**
 * Get keys from a Zod schema object.
 */
export type SchemaKeys<T extends z.ZodType> = keyof z.infer<T> & string;

/**
 * Get value type for a specific key in a Zod schema.
 */
export type SchemaValue<T extends z.ZodType, K extends SchemaKeys<T>> = z.infer<T>[K];

/**
 * Base schema that defines common properties for all cells.
 */
export const CellJson = z.strictObject({
	id: UuidWithDefault,
	created: DatetimeNow,
	/** Required and initially equal to `created`. */
	updated: DatetimeNow,
});
export type CellJson = z.infer<typeof CellJson>;
export type CellJsonInput = z.input<typeof CellJson>;
