// @slop Claude Opus 4

import type {ActionMethod} from './action_metatypes.js';
import type {ActionEventPhase, ActionKind, ActionSpecUnion} from '@fuzdev/fuz_app/action_spec.js';

import type {ActionEventEnvironment, ActionEventStep} from './action_event_types.js';
import {ActionEventData} from './action_event_data.js';
import {
	validate_step_transition,
	validate_phase_transition,
	should_validate_output,
	is_action_complete,
	create_initial_data,
	get_initial_phase,
	is_request_response,
	is_send_request_with_parsed_input,
	is_notification_send_with_parsed_input,
} from './action_event_helpers.js';
import type {ActionEventDatas} from './action_collections.js';
import {safe_parse_action_input, safe_parse_action_output} from './action_collection_helpers.js';
import {
	create_jsonrpc_request,
	create_jsonrpc_response,
	create_jsonrpc_error_message,
	create_jsonrpc_notification,
	to_jsonrpc_params,
	to_jsonrpc_result,
	is_jsonrpc_error_message,
} from './jsonrpc_helpers.js';
import {create_uuid, format_zod_validation_error} from './zod_helpers.js';
import {jsonrpc_error_messages, ThrownJsonrpcError} from './jsonrpc_errors.js';
import type {
	JsonrpcRequest,
	JsonrpcResponseOrError,
	JsonrpcNotification,
	JsonrpcErrorJson,
} from './jsonrpc.js';

// TODO maybe just use runes in this module and remove `observe`
export type ActionEventChangeObserver<TMethod extends ActionMethod> = (
	new_data: ActionEventDatas[TMethod],
	old_data: ActionEventDatas[TMethod],
	event: ActionEvent<TMethod>,
) => void;

/**
 * Action event that manages the lifecycle of an action through its state machine.
 */
export class ActionEvent<
	TMethod extends ActionMethod = ActionMethod,
	TEnvironment extends ActionEventEnvironment = ActionEventEnvironment,
	TPhase extends ActionEventPhase = ActionEventPhase,
	TStep extends ActionEventStep = ActionEventStep,
> {
	#data: ActionEventDatas[TMethod];
	#listeners: Set<ActionEventChangeObserver<TMethod>> = new Set();

	readonly environment: TEnvironment;
	readonly spec: ActionSpecUnion;

	get data(): ActionEventDatas[TMethod] & {phase: TPhase; step: TStep} {
		return this.#data as ActionEventDatas[TMethod] & {phase: TPhase; step: TStep};
	}

	// TODO hacky but preserves the API
	// TODO maybe app/server should be frontend/backend?
	get app(): TEnvironment {
		if (this.environment.executor !== 'frontend') {
			throw new Error('`action_event.app` can only be accessed in frontend environments');
		}
		return this.environment;
	}

	get backend(): TEnvironment {
		if (this.environment.executor !== 'backend') {
			throw new Error('`action_event.backend` can only be accessed in backend environments');
		}
		return this.environment;
	}

	constructor(environment: TEnvironment, spec: ActionSpecUnion, data: ActionEventDatas[TMethod]) {
		this.environment = environment;
		this.spec = spec;
		this.#data = data;
	}

	toJSON(): ActionEventDatas[TMethod] {
		return structuredClone(this.#data);
	}

	// TODO rethink the reactivity of this class, maybe just use `$state` or `$state.raw`?
	// does that have any negative implications when used on the backend?
	observe(listener: ActionEventChangeObserver<TMethod>): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	set_data(new_data: ActionEventDatas[TMethod]): void {
		const old_data = this.#data;
		this.#data = new_data;

		// Notify listeners
		for (const listener of this.#listeners) {
			listener(new_data, old_data, this);
		}
	}

	/**
	 * Parse input data according to the action's schema.
	 */
	parse(): this {
		if (this.#data.step !== 'initial') {
			throw new Error(`cannot parse from step '${this.#data.step}' - must be 'initial'`);
		}

		// Check for error in response - transition to receive_error instead of failing
		if (is_jsonrpc_error_message(this.#data.response)) {
			if (this.#data.kind === 'request_response' && this.#data.phase === 'receive_response') {
				// Transition to receive_error instead of failing
				this.#transition_to_error_phase('receive_error', this.#data.response.error);
				return this;
			}
			// Fallback for unexpected phases
			this.#fail(this.#data.response.error);
			return this;
		}

		const parsed = safe_parse_action_input(this.spec.method as ActionMethod, this.#data.input);
		if (parsed.success) {
			this.#transition_step('parsed', {input: parsed.data});
		} else {
			// Input validation errors fail immediately without transitioning to error phases.
			// Design decision: Input validation failures are client-side programming errors
			// that should be caught during development, not runtime errors requiring error handlers.
			// Handler errors (network, server, business logic) DO transition to error phases.
			this.#fail(
				// no need to protect this info
				jsonrpc_error_messages.invalid_params(
					`failed to parse input: ${format_zod_validation_error(parsed.error)}`,
					{validation_errors: parsed.error.issues},
				),
			);
		}

		return this;
	}

	/**
	 * Execute the handler for the current phase.
	 */
	// TODO add timeout support
	// TODO add cancellation support
	async handle_async(): Promise<void> {
		if (this.#data.step === 'failed') {
			return; // already failed, no-op
		}
		if (this.#data.step !== 'parsed') {
			throw new Error(`cannot handle from step '${this.#data.step}' - must be 'parsed'`);
		}

		this.#transition_step('handling', this.#create_handling_updates());

		const handler = this.environment.lookup_action_handler(
			this.spec.method as ActionMethod,
			this.#data.phase,
		);
		if (!handler) {
			this.#transition_step('handled');
			return;
		}

		try {
			const result = await handler(this);
			this.#complete_handling(result);
		} catch (error) {
			// Preserve ThrownJsonrpcError structure, wrap others as internal_error
			const error_json =
				error instanceof ThrownJsonrpcError
					? {code: error.code, message: error.message, data: error.data}
					: jsonrpc_error_messages.internal_error('unknown error');

			// If we're already in an error phase, transition to failed
			// Otherwise, transition to appropriate error phase
			if (this.#data.phase === 'send_error' || this.#data.phase === 'receive_error') {
				this.#fail(error_json);
			} else {
				// Transition to appropriate error phase
				const error_phase = this.#get_error_phase_for_current_phase();
				if (error_phase) {
					this.#transition_to_error_phase(error_phase, error_json);
				} else {
					this.#fail(error_json);
				}
			}
		}
	}

	/**
	 * Execute handler synchronously (only for sync local_call actions).
	 */
	handle_sync(): void {
		if (this.spec.kind !== 'local_call' || this.spec.async) {
			throw new Error('handle_sync can only be used with synchronous local_call actions');
		}

		if (this.#data.step === 'failed') {
			return; // already failed, no-op
		}
		if (this.#data.step !== 'parsed') {
			throw new Error(`cannot handle from step '${this.#data.step}' - must be 'parsed'`);
		}

		this.#transition_step('handling', this.#create_handling_updates());

		const handler = this.environment.lookup_action_handler(
			this.spec.method as ActionMethod,
			this.#data.phase,
		);
		if (!handler) {
			this.#transition_step('handled');
			return;
		}

		try {
			const result = handler(this);
			this.#complete_handling(result);
		} catch (error) {
			// Preserve ThrownJsonrpcError structure, wrap others as internal_error
			const error_json =
				error instanceof ThrownJsonrpcError
					? {code: error.code, message: error.message, data: error.data}
					: jsonrpc_error_messages.internal_error('unknown error');

			this.#fail(error_json);
		}
	}

	/**
	 * Transition to a new phase.
	 */
	transition(phase: ActionEventPhase): void {
		if (this.#data.step === 'failed') {
			return; // already failed, no-op
		}
		if (this.#data.step !== 'handled') {
			throw new Error(`cannot transition from step '${this.#data.step}' - must be 'handled'`);
		}

		validate_phase_transition(this.#data.phase, phase);

		// Create new data for the phase
		const new_data = this.#create_phase_data(phase);
		this.set_data(new_data);
	}

	is_complete(): boolean {
		return is_action_complete(this.#data);
	}

	update_progress(progress: unknown): void {
		this.#update_data({progress});
	}

	set_request(request: JsonrpcRequest): void {
		this.#validate_protocol_setter('request', {
			kind: 'request_response',
			phase: 'receive_request',
		});
		this.#update_data({request});
	}

	set_response(response: JsonrpcResponseOrError): void {
		this.#validate_protocol_setter('response', {
			kind: 'request_response',
			phase: 'receive_response',
		});

		const output = 'result' in response ? response.result : null;
		this.#update_data({response, output});
	}

	set_notification(notification: JsonrpcNotification): void {
		this.#validate_protocol_setter('notification', {
			kind: 'remote_notification',
			phase: 'receive',
		});
		this.#update_data({notification});
	}

	#transition_step(step: ActionEventStep, updates?: Partial<ActionEventData>): void {
		validate_step_transition(this.#data.step, step);
		this.#update_data({...updates, step});
	}

	/** Shallowly merge `updates` with the current data immutably. */
	#update_data(updates: Partial<ActionEventData>): void {
		const new_data = {...this.#data, ...updates} as ActionEventDatas[TMethod];
		this.set_data(new_data);
	}

	// TODO usage of this in this module is silently swallowing errors, maybe log on the environment?
	#fail(error: JsonrpcErrorJson): void {
		this.#transition_step('failed', {error});
	}

	/**
	 * Determine which error phase to transition to based on current phase.
	 */
	#get_error_phase_for_current_phase(): 'send_error' | 'receive_error' | null {
		if (this.#data.kind !== 'request_response') return null;

		switch (this.#data.phase) {
			case 'send_request':
			case 'receive_request':
				return 'send_error';
			case 'receive_response':
				return 'receive_error';
			default:
				return null;
		}
	}

	/**
	 * Transition to an error phase instead of failing.
	 */
	#transition_to_error_phase(phase: 'send_error' | 'receive_error', error: JsonrpcErrorJson): void {
		const new_data = {
			...this.#data,
			phase,
			step: 'parsed' as const,
			error,
			output: null,
		};
		this.set_data(new_data as ActionEventDatas[TMethod]);
	}

	#validate_protocol_setter(
		field: string,
		requirements: {kind: ActionKind; phase: ActionEventPhase},
	): void {
		if (this.#data.kind !== requirements.kind || this.#data.phase !== requirements.phase) {
			throw new Error(`can only set ${field} in ${requirements.phase} phase`);
		}
		if (this.#data.step !== 'initial') {
			throw new Error(`can only set ${field} at initial step`);
		}
	}

	#create_handling_updates(): Partial<ActionEventData> | undefined {
		// Create protocol messages when transitioning to 'handling' step
		// We check for 'parsed' state since this method is called before the transition
		if (is_send_request_with_parsed_input(this.#data)) {
			return {
				request: create_jsonrpc_request(
					this.spec.method,
					to_jsonrpc_params(this.#data.input),
					create_uuid(),
				),
			};
		}

		if (is_notification_send_with_parsed_input(this.#data)) {
			return {
				notification: create_jsonrpc_notification(
					this.spec.method,
					to_jsonrpc_params(this.#data.input),
				),
			};
		}

		return undefined;
	}

	#complete_handling(output: unknown): void {
		if (output !== undefined && should_validate_output(this.spec.kind, this.#data.phase)) {
			const parsed = safe_parse_action_output(this.spec.method as ActionMethod, output);
			if (parsed.success) {
				this.#transition_step('handled', {output: parsed.data});
			} else {
				this.#fail(
					jsonrpc_error_messages.validation_error(
						`failed to parse output: ${format_zod_validation_error(parsed.error)}`,
						{output, validation_errors: parsed.error.issues},
					),
				);
			}
		} else {
			this.#transition_step('handled');
		}
	}

	#create_phase_data(phase: ActionEventPhase): ActionEventDatas[TMethod] {
		const base_data = create_initial_data(
			this.#data.kind,
			phase,
			this.#data.method,
			this.#data.executor,
			this.#data.input,
		);

		// Carry forward data based on transition
		if (is_request_response(this.#data)) {
			if (phase === 'receive_response' && this.#data.request) {
				// Carry forward the request when transitioning to receive_response
				return {...base_data, request: this.#data.request} as ActionEventDatas[TMethod];
			} else if (phase === 'send_response' && this.#data.request) {
				// Create the response when transitioning to send_response
				const response = this.#create_response_from_data();
				return {
					...base_data,
					output: this.#data.output,
					request: this.#data.request,
					response,
				} as ActionEventDatas[TMethod];
			} else if (phase === 'send_error' && this.#data.error) {
				// Carry forward error and request (if available) when transitioning to send_error
				return {
					...base_data,
					error: this.#data.error,
					request: this.#data.request || null,
				} as ActionEventDatas[TMethod];
			} else if (phase === 'receive_error' && this.#data.error) {
				// Carry forward error, request, and response when transitioning to receive_error
				return {
					...base_data,
					error: this.#data.error,
					request: this.#data.request,
					response: this.#data.response,
				} as ActionEventDatas[TMethod];
			}
		}

		return base_data as ActionEventDatas[TMethod];
	}

	#create_response_from_data(): JsonrpcResponseOrError {
		if (!is_request_response(this.#data) || !this.#data.request) {
			throw new Error('cannot create response without request');
		}

		if (this.#data.error) {
			return create_jsonrpc_error_message(this.#data.request.id, this.#data.error);
		}

		const result = to_jsonrpc_result(this.#data.output);
		return create_jsonrpc_response(this.#data.request.id, result);
	}
}

// TODO not sure about this helper's design/location (should it be internal to the class constructor? a static method?)
/**
 * Create an action event from a spec and initial input.
 */
export const create_action_event = <TMethod extends ActionMethod>(
	environment: ActionEventEnvironment,
	spec: ActionSpecUnion,
	input: unknown,
	initial_phase?: ActionEventPhase,
): ActionEvent<TMethod> => {
	const phase = initial_phase || get_initial_phase(spec.kind, spec.initiator, environment.executor);
	if (!phase) {
		throw new Error(
			`executor '${environment.executor}' cannot initiate action '${spec.method}' with initiator '${spec.initiator}'`,
		);
	}

	const initial_data = create_initial_data(
		spec.kind,
		phase,
		spec.method as ActionMethod,
		environment.executor,
		input,
	) as ActionEventDatas[TMethod];

	return new ActionEvent(environment, spec, initial_data);
};

/**
 * Reconstruct an action event from serialized JSON data.
 */
export const create_action_event_from_json = <TMethod extends ActionMethod>(
	json: ActionEventDatas[TMethod],
	environment: ActionEventEnvironment,
): ActionEvent<TMethod> => {
	const spec = environment.lookup_action_spec(json.method);
	if (!spec) {
		throw new Error(`no spec found for method '${json.method}'`);
	}

	return new ActionEvent(environment, spec, json);
};

// TODO this and the above one arent used atm, see the comment on `create_action_event` too
// TODO how to avoid casting? this should generally be safe but we dont have schemas for each possible action event state
export const parse_action_event = (
	raw_json: unknown,
	environment: ActionEventEnvironment,
): ActionEvent => {
	const json = ActionEventData.parse(raw_json);
	return create_action_event_from_json(json as ActionEventDatas[typeof json.method], environment);
};
