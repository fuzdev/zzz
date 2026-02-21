// @slop Claude Opus 4

import type {z} from 'zod';
import type {Flavored} from '@fuzdev/fuz_util/types.js';
import {UnreachableError} from '@fuzdev/fuz_util/error.js';

import type {
	ActionSpecUnion,
	RequestResponseActionSpec,
	RemoteNotificationActionSpec,
	LocalCallActionSpec,
} from '@fuzdev/fuz_app/action_spec.js';
import type {ActionMethod} from './action_metatypes.js';

// TODO currently unused

export type VocabName = Flavored<string, 'VocabName'>;

/**
 * A central registry for schemas and actions.
 * Provides a single source of truth for schema definitions.
 */
export class SchemaRegistry {
	/**
	 * All schemas, including model schemas, action params, and responses.
	 */
	schemas: Array<z.ZodType> = [];

	/**
	 * Model schemas are distinct from the action schemas.
	 * Models are the nouns compared to the Action verbs,
	 * and compared to Views they are data not Svelte components.
	 */
	model_schemas: Array<z.ZodType> = [];

	/**
	 * Action parameter schemas.
	 */
	action_params_schemas: Array<z.ZodType> = [];

	/**
	 * Action response schemas.
	 */
	action_response_schemas: Array<z.ZodType> = [];

	/**
	 * Map of schema names to schemas.
	 */
	schema_by_name: Map<VocabName, z.ZodType> = new Map();

	/**
	 * Map of schemas to their names, for reverse lookup.
	 * Zod schemas don't have a `name` property and we don't want to abuse `description`.
	 */
	name_by_schema: Map<z.ZodType, VocabName> = new Map();

	/**
	 * Collection of all action specs.
	 */
	action_specs: Array<ActionSpecUnion> = [];

	/**
	 * Collection of 'request_response' action specs.
	 */
	request_response_action_specs: Array<RequestResponseActionSpec> = [];

	/**
	 * Collection of 'remote_notification' action specs.
	 */
	remote_notification_action_specs: Array<RemoteNotificationActionSpec> = [];

	/**
	 * Collection of 'local_call' action specs.
	 */
	local_call_action_specs: Array<LocalCallActionSpec> = [];

	/**
	 * Map of action spec names to action specs.
	 */
	action_spec_by_name_map: Map<ActionMethod, ActionSpecUnion> = new Map();

	/**
	 * Add a schema to the appropriate registries.
	 */
	add_schema(name: VocabName, schema: z.ZodType | ActionSpecUnion): void {
		if ('_def' in schema) {
			// It's a Zod schema
			this.schemas.push(schema);
			this.schema_by_name.set(name, schema);
			this.name_by_schema.set(schema, name);

			if (name.endsWith('_Params')) {
				this.action_params_schemas.push(schema);
			} else if (name.endsWith('_Response')) {
				this.action_response_schemas.push(schema);
			} else {
				this.model_schemas.push(schema);
			}
		} else if ('type' in schema) {
			// It's an action spec
			this.action_specs.push(schema);
			this.action_spec_by_name_map.set(schema.method as ActionMethod, schema);

			switch (schema.kind) {
				case 'request_response':
					this.request_response_action_specs.push(schema);
					break;
				case 'remote_notification':
					this.remote_notification_action_specs.push(schema);
					break;
				case 'local_call':
					this.local_call_action_specs.push(schema);
					break;
				default:
					throw new UnreachableError(schema);
			}
		}
	}

	/**
	 * Register multiple schemas at once.
	 */
	register_many(schemas: Record<string, any>): void {
		for (const name in schemas) {
			this.add_schema(name as VocabName, schemas[name]);
		}
	}

	/**
	 * Lookup a schema name, guaranteed to return a string, or throws.
	 */
	lookup_schema_name(schema: z.ZodType): VocabName {
		const name = this.name_by_schema.get(schema);
		if (!name) {
			throw new Error(`Schema not found in name_by_schema registry`);
		}
		return name;
	}

	/**
	 * Get an action specification by method name.
	 */
	get_action_spec(method: ActionMethod): ActionSpecUnion | undefined {
		return this.action_spec_by_name_map.get(method);
	}

	/**
	 * Get all schema names.
	 */
	get schema_names(): Array<VocabName> {
		return Array.from(this.schema_by_name.keys());
	}

	/**
	 * Get a schema by name.
	 */
	get_schema(name: VocabName): z.ZodType | undefined {
		return this.schema_by_name.get(name);
	}
}

/**
 * Global instance of the schema registry for convenience.
 */
export const global_schema_registry = new SchemaRegistry();
