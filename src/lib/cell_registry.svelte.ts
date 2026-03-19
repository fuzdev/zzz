import type {ClassConstructor} from '@fuzdev/fuz_util/types.js';
import type {z} from 'zod';
import {DEV} from 'esm-env';

import type {Cell} from './cell.svelte.js';
import type {Frontend} from './frontend.svelte.js';
import type {CellRegistryMap} from './cell_classes.js';
import type {Uuid} from './zod_helpers.js';

/**
 * Error thrown when attempting to instantiate an unregistered class.
 */
export class ClassNotRegisteredError extends Error {
	readonly class_name: string;
	readonly available_classes: Array<string>;

	constructor(class_name: string, available_classes: Array<string>, options?: ErrorOptions) {
		const message = `Class "${class_name}" is not registered. Available classes: ${available_classes.join(', ')}`;
		super(message, options);
		this.name = 'ClassNotRegisteredError';
		this.class_name = class_name;
		this.available_classes = available_classes;
	}
}

/**
 * Registry for managing cell classes and their instances.
 * The goal is to allow dynamic instantiation of all cells from serializable JSON.
 * `CellRegistry` does not currently justify its weight/complexity and may be removed in the future,
 * but I want to continue exploring the ideas behind it until we get fully snapshottable UI.
 */
export class CellRegistry {
	readonly app: Frontend;

	readonly #constructors: Map<string, ClassConstructor<Cell>> = new Map();

	readonly class_names: Array<string> = $derived(Array.from(this.#constructors.keys()));

	// TODO maybe make this a reactive SvelteMap? or delete this feature completely?
	// currently not using except it logs some errors on mistakes, but I think there's a lot of potential,
	// the idea being total knowledge of the full cell graph in memory,
	// and we could potentially make the collection itself reactive
	readonly all: Map<Uuid, Cell> = new Map();

	constructor(app: Frontend) {
		this.app = app;
	}

	/**
	 * Register a cell class with the registry.
	 */
	register(constructor: ClassConstructor<Cell>): void {
		const class_name = constructor.name;
		if (DEV && this.#constructors.has(class_name)) {
			console.error(`Class "${class_name}" is already registered, overwriting.`);
		}
		this.#constructors.set(class_name, constructor);
	}

	/**
	 * Unregister a cell class from the registry.
	 */
	unregister(class_name: string): boolean {
		if (DEV && !this.#constructors.has(class_name)) {
			console.error(`Cannot unregister "${class_name}": class not found in registry`);
		}
		return this.#constructors.delete(class_name);
	}

	/**
	 * Attempt to instantiate a class, returning null if not found.
	 * Logs an error in development if the class isn't registered.
	 */
	maybe_instantiate<K extends keyof CellRegistryMap>(
		class_name: K,
		json?: CellRegistryMap[K] extends Cell<infer TSchema> ? z.input<TSchema> : never,
		options?: object,
	): CellRegistryMap[K] | null {
		const constructor = this.#constructors.get(class_name);
		if (!constructor) {
			if (DEV) {
				console.error(
					`Class "${class_name}" is not registered. Available classes: ${this.class_names.join(', ')}`,
				);
			}
			return null;
		}

		// Create a new instance with the provided options and cast to the specific type
		return new constructor({...options, app: this.app, json}) as CellRegistryMap[K];
	}

	/**
	 * Create an instance of a registered cell class by name.
	 * Throws if the class isn't found.
	 *
	 * Type is automatically inferred from class name literals.
	 */
	instantiate<K extends keyof CellRegistryMap>(
		class_name: K,
		json?: CellRegistryMap[K] extends Cell<infer TSchema> ? z.input<TSchema> : never,
		options?: object,
	): CellRegistryMap[K] {
		const constructor = this.#constructors.get(class_name);
		if (!constructor) {
			throw new ClassNotRegisteredError(class_name, this.class_names);
		}

		// Create a new instance with the provided options and cast to the specific type
		return new constructor({...options, app: this.app, json}) as CellRegistryMap[K];
	}

	add_cell(cell: Cell<any>): void {
		if (DEV && this.all.has(cell.id)) {
			console.error(
				cell === this.all.get(cell.id)
					? `registry already has this cell instance: ${cell.id}`
					: `registry already has a different cell instance with this id: ${cell.id}`,
				cell.toJSON(),
				this.all.get(cell.id)?.toJSON(),
			);
		}
		this.all.set(cell.id, cell);
	}

	remove_cell(id: Uuid): void {
		if (DEV && !this.all.has(id)) {
			console.error(`cell not found in registry: ${id}`);
		}
		this.all.delete(id);
	}
}
