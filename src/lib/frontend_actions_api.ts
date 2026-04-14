import type {ActionMethod, ActionsApi} from './action_metatypes.js';
import type {ActionEventEnvironment} from './action_event_types.js';
import {create_action_event} from './action_event.js';
import type {
	ActionSpecUnion,
	LocalCallActionSpec,
	RemoteNotificationActionSpec,
	RequestResponseActionSpec,
} from '@fuzdev/fuz_app/actions/action_spec.js';
import {
	is_send_request,
	is_notification_send,
	extract_action_result,
} from './action_event_helpers.js';
import type {ActionPeer} from './action_peer.js';
import type {Actions} from './actions.svelte.js';

// TODO @api @many refactor frontend_actions_api.ts with action_peer.ts

// TODO @api think about unification between frontend|backend_actions_api.ts

/**
 * Creates the actions API methods for the frontend.
 * Uses a Proxy to provide dynamic method lookup with full type safety.
 */
export const create_frontend_actions_api = (
	peer: ActionPeer,
	environment: ActionEventEnvironment,
	actions?: Actions,
): ActionsApi => {
	return new Proxy({} as ActionsApi, {
		get(_target, method: string) {
			const spec = environment.lookup_action_spec(method as ActionMethod);
			if (!spec) {
				return undefined;
			}

			return create_action_method(peer, environment, spec, actions);
		},
		has(_target, method: string) {
			return environment.lookup_action_spec(method as ActionMethod) !== undefined;
		},
	});
};

/**
 * Creates a method that executes an action through its complete lifecycle.
 */
const create_action_method = (
	peer: ActionPeer,
	environment: ActionEventEnvironment,
	spec: ActionSpecUnion,
	actions?: Actions,
) => {
	switch (spec.kind) {
		case 'local_call':
			return spec.async
				? create_async_local_call_method(environment, spec, actions)
				: create_sync_local_call_method(environment, spec, actions);
		case 'request_response':
			return create_request_response_method(peer, environment, spec, actions);
		case 'remote_notification':
			return create_remote_notification_method(peer, environment, spec, actions);
	}
};

/**
 * Creates a synchronous local call method.
 * Returns value directly - can throw on error (sync methods cannot return Result).
 */
const create_sync_local_call_method = (
	environment: ActionEventEnvironment,
	spec: LocalCallActionSpec,
	actions?: Actions,
) => {
	return (input?: unknown) => {
		const event = create_action_event(environment, spec, input);
		const action = actions?.add_from_json({
			method: spec.method as ActionMethod,
			action_event_data: event.toJSON(),
		});
		action?.listen_to_action_event(event);

		event.parse().handle_sync();

		const result = extract_action_result(event);
		if (result.ok) {
			return result.value;
		} else {
			// Sync methods must throw on error (cannot return Result synchronously)
			throw new Error(`${spec.method} failed: ${result.error.message}`);
		}
	};
};

/**
 * Creates an asynchronous local call method.
 * Returns Result for type-safe error handling.
 */
const create_async_local_call_method = (
	environment: ActionEventEnvironment,
	spec: LocalCallActionSpec,
	actions?: Actions,
) => {
	return async (input?: unknown) => {
		const event = create_action_event(environment, spec, input);
		const action = actions?.add_from_json({
			method: spec.method as ActionMethod,
			action_event_data: event.toJSON(),
		});
		action?.listen_to_action_event(event);

		await event.parse().handle_async();

		return extract_action_result(event);
	};
};

/**
 * Creates a request/response method that communicates over the network.
 */
const create_request_response_method = (
	peer: ActionPeer,
	environment: ActionEventEnvironment,
	spec: RequestResponseActionSpec,
	actions?: Actions,
) => {
	return async (input?: unknown) => {
		const event = create_action_event(environment, spec, input);
		const action = actions?.add_from_json({
			method: spec.method as ActionMethod,
			action_event_data: event.toJSON(),
		});
		action?.listen_to_action_event(event);

		await event.parse().handle_async();

		// Check if we're in send_error phase before type narrowing
		if (event.data.kind === 'request_response' && event.data.phase === 'send_error') {
			await event.handle_async(); // Call send_error handler
			return extract_action_result(event);
		}

		if (!is_send_request(event.data)) throw Error(); // TODO @many maybe make this an assertion helper?

		if (event.data.step !== 'handled') {
			return extract_action_result(event);
		}

		const response = await peer.send(event.data.request);

		event.transition('receive_response');

		// TODO @api shouldn't this happen in the peer like the other method calls?
		event.set_response(response);

		event.parse(); // May transition to receive_error

		await event.handle_async();

		return extract_action_result(event);
	};
};

/**
 * Creates a remote notification method (fire and forget).
 * Returns Result<{value: void}> for consistency.
 */
const create_remote_notification_method = (
	peer: ActionPeer,
	environment: ActionEventEnvironment,
	spec: RemoteNotificationActionSpec,
	actions?: Actions,
) => {
	return async (input?: unknown) => {
		const event = create_action_event(environment, spec, input);
		const action = actions?.add_from_json({
			method: spec.method as ActionMethod,
			action_event_data: event.toJSON(),
		});
		action?.listen_to_action_event(event);

		await event.parse().handle_async();

		if (!is_notification_send(event.data)) throw Error(); // TODO @many maybe make this an assertion helper?

		if (event.data.step === 'handled') {
			const send_result = await peer.send(event.data.notification);
			// Check if notification failed to send
			if (send_result !== null) {
				environment.log?.error('notification send failed:', send_result.error);
				return {ok: false, error: send_result.error};
			}
			return {ok: true, value: undefined};
		}

		return extract_action_result(event);
	};
};
