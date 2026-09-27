import type { ActionEventData } from '@fuzdev/fuz_app/actions/action_event_data.ts';

/**
 * The most JSON, in characters, the actions log keeps of one payload — an
 * action's `input`, `output`, `progress`, request params, response result,
 * notification params, or error data. A larger payload is replaced by an
 * `ActionPayloadOmitted` marker, so the log's 512 entries stay small even when
 * calls carry file contents (`session_load`, `diskfile_update`) or whole chat
 * histories (`completion_create`).
 */
export const ACTION_PAYLOAD_BUDGET = 8192;

/** Stands in for a payload the actions log didn't keep. */
export interface ActionPayloadOmitted {
	zzz_payload_omitted: string;
}

/**
 * Creates the marker for a payload over `budget`.
 */
export const create_action_payload_omitted = (budget: number): ActionPayloadOmitted => ({
	zzz_payload_omitted: `over ${budget} characters of JSON, not kept in the actions log`
});

/**
 * Whether `value` is an `ActionPayloadOmitted` marker.
 */
export const is_action_payload_omitted = (value: unknown): value is ActionPayloadOmitted =>
	typeof value === 'object' &&
	value !== null &&
	typeof (value as Record<string, unknown>).zzz_payload_omitted === 'string';

/**
 * Estimates the length of `value` serialized as JSON, stopping as soon as it
 * passes `limit` — so the cost is bounded by `limit`, not by the value's size.
 * The estimate ignores string escaping, so it can undercount strings full of
 * characters JSON escapes.
 *
 * @param value - the value to measure
 * @param limit - the length to stop measuring at
 * @returns the estimated length, or a number over `limit` once it's passed
 */
export const estimate_json_length = (value: unknown, limit: number): number => {
	let length = 0;
	const stack: Array<unknown> = [value];
	while (stack.length > 0) {
		if (length > limit) return length;
		const v = stack.pop();
		switch (typeof v) {
			case 'string':
				length += v.length + 2;
				break;
			case 'number':
			case 'boolean':
				length += String(v).length;
				break;
			case 'object':
				if (v === null) {
					length += 4;
				} else if (Array.isArray(v)) {
					length += 2 + Math.max(0, v.length - 1);
					for (let i = v.length - 1; i >= 0; i--) {
						stack.push(v[i]);
						// every pending value serializes to at least one character
						if (length + stack.length > limit) return limit + 1;
					}
				} else {
					length += 2;
					let first = true;
					for (const key in v) {
						if (!Object.hasOwn(v, key)) continue;
						const child = (v as Record<string, unknown>)[key];
						if (child === undefined || typeof child === 'function') continue;
						length += key.length + (first ? 3 : 4); // quotes, colon, and a comma after the first
						first = false;
						stack.push(child);
						if (length + stack.length > limit) return limit + 1;
					}
				}
				break;
			default:
				// undefined, functions, and symbols serialize to nothing
				break;
		}
	}
	return length;
};

/**
 * Whether the JSON of `value` is over `budget` characters.
 */
export const is_action_payload_over_budget = (
	value: unknown,
	budget: number = ACTION_PAYLOAD_BUDGET
): boolean => {
	if (typeof value === 'string') return value.length + 2 > budget;
	if (typeof value !== 'object' || value === null) return false;
	return estimate_json_length(value, budget) > budget;
};

/**
 * Bounds what the actions log keeps of an action event's data: each payload
 * over `budget` — `input`, `output`, `progress`, the request's `params`, the
 * response's `result` (or its error's `data`), the notification's `params`,
 * and the error's `data` — becomes an `ActionPayloadOmitted` marker, and an
 * error `message` over `budget` characters is truncated (see
 * `truncate_action_error_message`) and flagged with
 * `ACTION_ERROR_MESSAGE_TRUNCATED_KEY`. The lifecycle fields (kind, phase, step,
 * method, executor), the JSON-RPC envelopes, and the error's code are always
 * kept, so the result still parses as `ActionEventData`. Returns `data` itself
 * when nothing is over the budget.
 */
export const bound_action_event_data = (
	data: ActionEventData,
	budget: number = ACTION_PAYLOAD_BUDGET
): ActionEventData => {
	const over = (value: unknown): boolean => is_action_payload_over_budget(value, budget);
	const omitted = (): ActionPayloadOmitted => create_action_payload_omitted(budget);

	let changed = false;
	const bounded: ActionEventData = { ...data };
	if (over(data.input)) {
		bounded.input = omitted();
		changed = true;
	}
	if (over(data.output)) {
		bounded.output = omitted();
		changed = true;
	}
	if (over(data.progress)) {
		bounded.progress = omitted();
		changed = true;
	}
	if (data.error) {
		const error = bound_error_object(data.error, budget);
		if (error !== data.error) {
			bounded.error = error;
			changed = true;
		}
	}
	if (data.request && over(data.request.params)) {
		bounded.request = { ...data.request, params: { ...omitted() } };
		changed = true;
	}
	if (data.notification && over(data.notification.params)) {
		bounded.notification = { ...data.notification, params: { ...omitted() } };
		changed = true;
	}
	const { response } = data;
	if (response) {
		if ('result' in response) {
			if (over(response.result)) {
				bounded.response = { ...response, result: { ...omitted() } };
				changed = true;
			}
		} else {
			const error = bound_error_object(response.error, budget);
			if (error !== response.error) {
				bounded.response = { ...response, error };
				changed = true;
			}
		}
	}
	return changed ? bounded : data;
};

/**
 * Truncates an error `message` longer than `budget` characters, noting the
 * original length — output-validation messages for a huge payload can be
 * arbitrarily long.
 */
export const truncate_action_error_message = (
	message: string,
	budget: number = ACTION_PAYLOAD_BUDGET
): string =>
	message.length > budget
		? `${message.slice(0, budget)}… [truncated from ${message.length} characters]`
		: message;

/**
 * Set on an error whose `message` `bound_action_event_data` truncated, to the
 * message's original length. JSON-RPC error objects allow extra members, so
 * the bounded error still parses.
 */
export const ACTION_ERROR_MESSAGE_TRUNCATED_KEY = 'zzz_message_truncated_from';

/**
 * Whether `error` is one whose `message` `bound_action_event_data` truncated.
 */
export const is_action_error_message_truncated = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	typeof (error as Record<string, unknown>)[ACTION_ERROR_MESSAGE_TRUNCATED_KEY] === 'number';

/** Bounds an error's `message` and `data`, returning `error` itself when both fit. */
const bound_error_object = <T extends { message: string; data?: unknown }>(
	error: T,
	budget: number
): T => {
	const message = truncate_action_error_message(error.message, budget);
	const data_over = is_action_payload_over_budget(error.data, budget);
	if (message === error.message && !data_over) return error;
	const bounded: T = { ...error, message };
	if (message !== error.message) {
		(bounded as Record<string, unknown>)[ACTION_ERROR_MESSAGE_TRUNCATED_KEY] = error.message.length;
	}
	if (data_over) bounded.data = create_action_payload_omitted(budget);
	return bounded;
};

/**
 * Whether `bound_action_event_data` omitted any of `data`'s payloads or
 * truncated an error message.
 */
export const action_event_data_has_omitted_payload = (data: ActionEventData): boolean =>
	is_action_error_message_truncated(data.error) ||
	(!!data.response &&
		'error' in data.response &&
		is_action_error_message_truncated(data.response.error)) ||
	is_action_payload_omitted(data.input) ||
	is_action_payload_omitted(data.output) ||
	is_action_payload_omitted(data.progress) ||
	is_action_payload_omitted(data.error?.data) ||
	is_action_payload_omitted(data.request?.params) ||
	is_action_payload_omitted(data.notification?.params) ||
	(!!data.response &&
		('result' in data.response
			? is_action_payload_omitted(data.response.result)
			: is_action_payload_omitted(data.response.error.data)));
