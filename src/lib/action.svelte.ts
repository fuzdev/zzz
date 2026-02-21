// @slop Claude Opus 4

import {z} from 'zod';

import {Cell, type CellOptions} from './cell.svelte.js';
import {ActionMethod} from './action_metatypes.js';
import {ActionKind} from '@fuzdev/fuz_app/action_spec.js';
import {ActionSpecs} from './action_collections.js';
import type {ActionSpecUnion} from '@fuzdev/fuz_app/action_spec.js';
import {CellJson} from './cell_types.js';
import {ActionEventData} from './action_event_data.js';
import type {ActionEvent} from './action_event.js';
import {is_action_complete} from './action_event_helpers.js';

// TODO this isnt in action_types.ts because of circular dependencies, idk what pattern is best yet
export const ActionJson = CellJson.extend({
	method: ActionMethod,
	action_event_data: ActionEventData.optional(),
}).meta({cell_class_name: 'Action'});
export type ActionJson = z.infer<typeof ActionJson>;
export type ActionJsonInput = z.input<typeof ActionJson>;

export interface ActionOptions extends CellOptions<typeof ActionJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

/**
 * Represents a single action in the system, tracking its full lifecycle through action events.
 */
export class Action extends Cell<typeof ActionJson> {
	method: ActionMethod = $state()!;

	// TODO maybe use a decoder to make this an `ActionEvent`
	action_event_data: ActionEventData | undefined = $state.raw();

	readonly spec: ActionSpecUnion = $derived.by(() => {
		const s = ActionSpecs[this.method] as ActionSpecUnion | undefined; // TODO refactor
		if (!s) throw new Error(`Missing action spec for method '${this.method}'`);
		return s;
	});

	readonly kind: ActionKind = $derived(this.spec.kind);

	readonly has_error = $derived(!!this.action_event_data?.error);

	/**
	 * Returns true if the action is still pending (not in a terminal state).
	 * An action is complete when it reaches a terminal phase (where next phase is null)
	 * AND the step is terminal (handled or failed).
	 */
	readonly pending = $derived.by(() => {
		if (!this.action_event_data) {
			return true; // no data yet means pending
		}

		// Use the is_action_complete helper which correctly checks both phase and step
		return !is_action_complete(this.action_event_data);
	});

	readonly failed = $derived(this.action_event_data?.step === 'failed');

	/**
	 * Returns true if the action completed successfully.
	 * Success means: action is complete (terminal phase + step), step is 'handled', and no error.
	 */
	readonly success = $derived.by(() => {
		if (!this.action_event_data) {
			return false; // no data yet means not successful
		}

		const {step, error} = this.action_event_data;

		// Action must be complete, step must be 'handled', and there must be no error
		return is_action_complete(this.action_event_data) && step === 'handled' && !error;
	});

	constructor(options: ActionOptions) {
		super(ActionJson, options);
		this.init();
	}

	// TODO @api temporary hacking this, rethink the reactivity/action_event usage with this class
	unlisten_to_action_event: (() => void) | undefined;
	action_event: ActionEvent | undefined;
	listen_to_action_event(action_event: ActionEvent): () => void {
		this.unlisten_to_action_event?.();
		this.action_event = action_event;
		const unobserve = action_event.observe((new_data) => {
			this.action_event_data = new_data;
		});
		this.unlisten_to_action_event = () => {
			unobserve();
			this.unlisten_to_action_event = undefined;
			this.action_event = undefined;
		};
		return this.unlisten_to_action_event;
	}

	// TODO automatic cleanup with a cell API
	override dispose(): void {
		super.dispose();
		this.unlisten_to_action_event?.();
	}
}

export const ActionSchema = z.instanceof(Action);
