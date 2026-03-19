import {z} from 'zod';

import {
	get_field_schema,
	zod_get_schema_keys,
	type Uuid,
	type Datetime,
	get_datetime_now,
} from './zod_helpers.js';
import type {Frontend} from './frontend.svelte.js';
import {
	get_schema_class_info,
	type SchemaClassInfo,
	HANDLED,
	type CellValueDecoder,
} from './cell_helpers.js';
import type {SchemaKeys, CellJson} from './cell_types.js';
import {format_datetime, format_short_date, format_time} from './time_helpers.js';

// TODO improve types, especially casting

/**
 * Any options besides these declared ones are ignored,
 * so they're safe to forward when subclassing without needing to extract the rest options.
 */
export interface CellOptions<TSchema extends z.ZodType> {
	app: Frontend; // TODO needs to be generic
	json?: z.input<TSchema>;
}

/**
 * A monotonic id for cell instances on the client.
 * This is not reactive and never changes on the instance,
 * whereas `id` can change. It's useful for ordering -
 * the motivating usecase was correctly sorting objects with the same `created` millisecond.
 *
 * This may cause issues based on how data gets queried, but at least it's stable once loaded.
 * However we may need to revisit this if it causes problems.
 */
export const get_global_cell_count = (): number => global_cell_count;
let global_cell_count = 0;

/**
 * The `Cell` is the base class for schema-driven data models in Zzz.
 * The goals are still evolving, but a main idea is to have fully reactive state
 * that can be flexibly snapshotted and reinstantiated in a typesafe, extensible system
 * that uses normal Svelte patterns.
 *
 * The design aims for:
 *
 * - Integration with Svelte's reactivity, encouraging single-depth inheritance
 * 		with Svelte class patterns for both persistent and ephemeral state
 * - Schema-driven parsing/validation and JSON serialization/deserialization
 * 		(supporting snapshot and restore/replay patterns) via Zod
 * - Custom property encoding/decoding for complex types,
 * 		and no boilerplate for schema-inferrable properties
 * - Lifecycle management with generic instantiation/registration and disposal
 * 		(conceptually a WIP, partially implemented)
 * - Runtime type metadata for reflection
 *
 * Cells are automatically registered in the global registry by `id`,
 * making them discoverable and referenceable throughout the system.
 * Each cell has common properties including `id` and `created`/`updated` timestamps.
 *
 * There are currently a lot of rough edges and missing features!
 * My hope is that this could be generic enough to extract to a library, but it's not there yet.
 * I assume there's a really nice design in this space that takes full advantage of Svelte runes.
 *
 * Many things will be possible with this pattern, but it's still a work in progress.
 */
export abstract class Cell<TSchema extends z.ZodType = z.ZodType> implements CellJson {
	readonly cid = ++global_cell_count;

	// Base properties from CellJson
	id: Uuid = $state()!;
	created: Datetime = $state()!;
	updated: Datetime = $state()!;

	// the `!` is needed for `$derived(` to work over `$derived.by(`
	readonly schema!: TSchema;

	readonly schema_keys: Array<SchemaKeys<TSchema>> = $derived(zod_get_schema_keys(this.schema));
	readonly field_schemas: Map<SchemaKeys<TSchema>, z.ZodType> = $derived(
		new Map(this.schema_keys.map((key) => [key, get_field_schema(this.schema, key)])),
	);
	readonly field_schema_info: Map<SchemaKeys<TSchema>, SchemaClassInfo | null> = $derived(
		new Map(
			this.schema_keys.map((key) => {
				const field_schema = this.field_schemas.get(key);
				if (!field_schema) {
					return [key, null];
				}
				return [key, get_schema_class_info(field_schema)];
			}),
		),
	);

	readonly json: z.output<TSchema> = $derived(this.to_json());
	readonly json_serialized: string = $derived(JSON.stringify(this.json));
	// TODO maybe add a variant `json_serialized_pretty` or `_formatted`
	readonly json_parsed: z.ZodSafeParseResult<z.output<TSchema>> = $derived.by(() =>
		this.schema.safeParse(this.json),
	);

	// TODO needs to be generic so users can extend it
	readonly app: Frontend;

	/**
	 * Type-safe decoders for custom field decoding.
	 * Override in subclasses to handle special field types.
	 *
	 * Each decoder function takes a value of any type and should either:
	 * 1. Return a value (including null) to be assigned to the property
	 * 2. Return undefined to use the default decoding behavior
	 * 3. Return `HANDLED` to indicate the decoder has fully processed the property
	 *    (virtual properties MUST return `HANDLED` if they exist in schema but not in class)
	 */
	protected decoders: CellValueDecoder<TSchema> = {};

	readonly created_date: Date = $derived(new Date(this.created));
	readonly created_formatted_short_date: string = $derived(format_short_date(this.created_date));
	readonly created_formatted_datetime: string = $derived(format_datetime(this.created_date));
	readonly created_formatted_time: string = $derived(format_time(this.created_date));

	readonly updated_date: Date = $derived(new Date(this.updated));
	readonly updated_formatted_short_date: string = $derived(format_short_date(this.updated_date));
	readonly updated_formatted_datetime: string = $derived(format_datetime(this.updated_date));
	readonly updated_formatted_time: string = $derived(format_time(this.updated_date));

	/** Stored only between construction and initialization. */
	#initial_json: z.input<TSchema> | undefined;

	constructor(schema: TSchema, options: CellOptions<TSchema>) {
		this.schema = schema;
		this.app = options.app;
		this.#initial_json = options.json;

		// Don't auto-initialize here - wait for subclass to call init()
		// so its properties initialize and constructor runs
	}

	/**
	 * Initialize the instance with `options.json` data if provided.
	 * Must be called before using the instance -
	 * the current pattern is calling it at the end of subclass constructors.
	 *
	 * We should investigate deferring to callers so e.g. instantiating from the registry
	 * would init automatically, subclasses need no init logic (which can get unwieldy with inheritance),
	 * and then callers could always do custom init patterns if they wanted.
	 *
	 * Can't be called automatically by the `Cell`'s constructor because
	 * the subclass' constructor needs to run first to support field initialization.
	 * A design goal behind the `Cell` is to support normal TS and Svelte patterns
	 * with the most power and least intrusion. (there's a balance to find from Zzz's POV)
	 */
	protected init(): void {
		const initial_json = this.#initial_json;
		this.#initial_json = undefined;
		this.set_json(initial_json); // `set_json` parses with the schema, so this may be `undefined` and it's fine

		// Add to global registry
		this.register();
	}

	/**
	 * Clean up resources when this cell is no longer needed.
	 */
	dispose(): void {
		// Remove from global registry
		this.unregister();

		// TODO handle disposing a subtree?

		// TODO any other cleanup needed? null out any references?
		// maybe things can register themselves to be tied to this cell's lifecycle
		// and we loop over those here?
	}

	/**
	 * This is not supported in Safari, don't rely on this yet.
	 * Uncomment temporarily to experiment in dev.
	 */
	[Symbol.dispose](): void {
		this.dispose();
	}

	/** Flag to track registration status - prevents double registration. */
	#registered = false;

	/**
	 * Register this cell in the global cell registry.
	 * Called automatically by `init()`.
	 */
	protected register(): void {
		if (this.#registered) {
			console.error(`Cell ${this.constructor.name} is already registered`);
			return;
		}

		this.app.cell_registry.add_cell(this);
		this.#registered = true;
	}

	/**
	 * Unregister this cell from the global cell registry.
	 * Called automatically by `dispose()`.
	 */
	protected unregister(): void {
		if (!this.#registered) return;

		this.app.cell_registry.remove_cell(this.id);
		this.#registered = false;
	}

	/**
	 * For Svelte's $snapshot.
	 */
	toJSON(): z.output<TSchema> {
		return this.json;
	}

	/**
	 * Encodes the cell's serializable state as JSON.
	 * Use the derived `cell.json` if you don't need a fresh copy.
	 */
	to_json(): z.output<TSchema> {
		const result = {} as Record<string, any>;

		for (const key of this.schema_keys) {
			if (key in this) {
				// We know the key exists in this instance, use index access with type assertion
				const value = (this as Record<string, unknown>)[key];
				result[key] = this.encode_property(value, key) as any;
			} else {
				console.error(`Property ${key} not found on instance of ${this.constructor.name}`);
			}
		}

		return result as z.output<TSchema>;
	}

	/**
	 * Apply JSON data to this instance.
	 * Overwrites all properties including 'id'.
	 * Special-cases `created` and `updated` for synchronization.
	 */
	set_json(value: z.input<TSchema> | undefined): void {
		try {
			// Prepare the input by ensuring `created`/`updated` are in sync when using defaults
			let v = value as any;
			if (!v || !('created' in v) || !v.created) {
				v = {...v};
				v.created = get_datetime_now();
			}
			if (!('updated' in v) || !v.updated) {
				if (v === value) {
					v = {...v};
				}
				v.updated = v.created;
			}

			// Parse with schema to apply defaults and validation
			const parsed = this.schema.parse(v);

			// Process each schema key
			for (const key of this.schema_keys) {
				// Get the value from parsed data (might be schema default)
				const parsed_value = (parsed as Record<string, any>)[key];

				// Process this schema property
				this.assign_property(key, parsed_value);
			}
		} catch (error) {
			console.error(`error setting JSON for ${this.constructor.name}:`, error);
			throw error; // Re-throw so tests that expect errors will pass
		}
	}

	/**
	 * Update only the specified properties on this instance.
	 * Preserves current values for any properties not included in the input.
	 */
	set_json_partial(partial_value: Partial<z.input<TSchema>>): void {
		if (!partial_value || typeof partial_value !== 'object') return; // eslint-disable-line @typescript-eslint/no-unnecessary-condition

		try {
			let v = partial_value as any;

			// Special handling for `created`/`updated` synchronization
			if ('created' in v && !('updated' in v)) {
				v = {...v};
				v.updated = v.created;
			}

			// Directly process each property in the partial update
			for (const key of Object.keys(v) as Array<SchemaKeys<TSchema>>) {
				// Skip empty properties
				if (v[key] === undefined) continue;

				// Get the field schema for this property
				const field_schema = this.field_schemas.get(key);
				if (!field_schema) {
					console.error(`Schema key "${key}" not found in schema for ${this.constructor.name}`);
					continue;
				}

				// Parse the individual value through its field schema
				try {
					const parsed_value = field_schema.parse(v[key]);

					// Assign the parsed property
					this.assign_property(key, parsed_value);
				} catch (field_error) {
					console.error(
						`Error parsing property "${key}" for ${this.constructor.name}:`,
						field_error,
					);
					throw field_error;
				}
			}
		} catch (error) {
			console.error(`error in partial update for ${this.constructor.name}:`, error);
			throw error;
		}
	}

	/**
	 * Encode a value during serialization. Can be overridden for custom encoding logic.
	 * Defaults to Svelte's `$state.snapshot`,
	 * which handles most cases and uses `toJSON` when available,
	 * so overriding `to_json` is sufficient for most cases before overriding `encode_property`.
	 */
	encode_property(value: unknown, _key: string): unknown {
		return $state.snapshot(value);
	}

	/**
	 * Decode a value based on its schema type information.
	 * This handles instantiating classes, transforming arrays, and special types.
	 *
	 * Complex property types might require custom handling in parser functions
	 * rather than using this general decoding mechanism.
	 */
	decode_property<K extends SchemaKeys<TSchema>>(value: unknown, key: K): any {
		const schema_info = this.field_schema_info.get(key);
		if (!schema_info) return value;

		// Handle arrays of cells
		if (schema_info.is_array && Array.isArray(value)) {
			if (schema_info.element_class) {
				return value.map((item) => {
					const instance = this.#instantiate_class(schema_info.element_class, item);
					// Return the item if instantiation returns null
					return instance !== null ? instance : item;
				});
			}
			return value;
		}

		// Handle special types first (Map and Set)
		if (schema_info.type === 'ZodMap' && Array.isArray(value)) {
			return new Map(value);
		}
		if (schema_info.type === 'ZodSet' && Array.isArray(value)) {
			return new Set(value);
		}

		// Handle individual cell
		if (schema_info.class_name && value && typeof value === 'object') {
			const instance = this.#instantiate_class(schema_info.class_name, value);
			// Return the original value if instantiation returns null
			return instance !== null ? instance : value;
		}

		return value;
	}

	/**
	 * Process a single schema property during JSON deserialization.
	 * This method handles the workflow for mapping schema properties to instance properties.
	 *
	 * Flow:
	 * 1. If a decoder exists for this property, try to use it
	 * 2. If decoder returns `HANDLED`, consider the property fully handled (short circuit)
	 * 3. If decoder returns a value other than `HANDLED` or undefined, use that value
	 * 4. If decoder returns undefined, fall through to standard decoding
	 * 5. For properties not directly represented in the class instance but defined
	 *    in the schema, the decoder MUST return `HANDLED` to indicate proper handling
	 */
	protected assign_property(key: SchemaKeys<TSchema>, value: unknown): void {
		// 1. Check if we have a property and decoder for this key
		const has_property = key in this;
		const has_decoder = key in this.decoders;

		// 2. If we don't have a property or decoder, log an error and bail
		if (!has_property && !has_decoder) {
			console.error(
				`Schema key "${key}" in ${this.constructor.name} has no matching property or decoder. ` +
					`Consider adding the property or a decoder.`,
			);
			return;
		}

		// 3. Try to use the decoder if available
		if (has_decoder) {
			const decoder = (this.decoders as Record<string, any>)[key];
			if (decoder) {
				const decoded = decoder(value);

				// 3a. If decoder returns HANDLED, it signals complete handling (short circuit)
				if (decoded === HANDLED) {
					return;
				}

				// 3b. If decoder returns a defined value AND we have a property, assign it
				// Note: this allows null values to be assigned
				if (decoded !== undefined && has_property) {
					(this as any)[key] = decoded;
					return;
				}

				// 3c. If decoder returns undefined, fall through to standard decoding

				// 3d. If we don't have a property but have a decoder that didn't return HANDLED,
				// that's an error - virtual properties MUST be explicitly handled
				if (!has_property) {
					console.error(
						`Decoder for schema property "${key}" in ${this.constructor.name} didn't return HANDLED. ` +
							`Virtual properties (not present on class) must explicitly return HANDLED.`,
					);
					return;
				}
			}
		}

		// 4. Use standard decoding if we have a property and value
		if (has_property && value !== undefined) {
			const decoded = this.decode_property(value, key);
			(this as any)[key] = decoded;
		}
	}

	/** Generic clone method that works for any subclass. */
	clone(json?: z.input<TSchema>, options?: CellOptions<TSchema>): this {
		const constructor = this.constructor as new (options: CellOptions<TSchema>) => this;

		const {id: _, ...current_json} = this.json as any;

		try {
			return new constructor({
				...options,
				app: this.app,
				json: structuredClone(json ? {...current_json, ...json} : current_json),
			});
		} catch (error) {
			console.error(`failed to clone instance of ${constructor.name}:`, error);
			throw new Error(`failed to clone: ${error.message}`);
		}
	}

	#instantiate_class(class_name: string | undefined, json: unknown, options?: object): unknown {
		if (!class_name) {
			console.error('No class name provided for instantiation');
			return null;
		}

		const instance = this.app.cell_registry.maybe_instantiate(class_name as any, json, options);
		if (!instance) console.error(`failed to instantiate ${class_name}`);
		return instance;
	}
}
