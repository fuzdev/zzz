// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';
import { create_action_event } from '@fuzdev/fuz_app/actions/action_event.ts';
import type {
	ActionEventEnvironment,
	ActionExecutor
} from '@fuzdev/fuz_app/actions/action_event_types.ts';
import type { ActionSpecUnion } from '@fuzdev/fuz_app/actions/action_spec.ts';
import type {
	ActionEventData,
	ActionEventDataUnion
} from '@fuzdev/fuz_app/actions/action_event_data.ts';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Action } from '$lib/action.svelte.ts';
import { toggle_main_menu_action_spec } from '$lib/action_specs.ts';
import { ACTION_PAYLOAD_BUDGET, is_action_payload_omitted } from '$lib/action_helpers.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const environment: ActionEventEnvironment = {
	executor: 'frontend' as ActionExecutor,
	lookup_action_handler: () => undefined,
	lookup_action_spec: (method) =>
		method === toggle_main_menu_action_spec.method
			? (toggle_main_menu_action_spec as ActionSpecUnion)
			: undefined
};

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('listen_to_action_event', () => {
	test('keeps a bounded copy of the data and lets go of the event once complete', () => {
		const event = create_action_event(environment, toggle_main_menu_action_spec, {});
		const action = new Action({ app, json: { method: 'toggle_main_menu' } });
		action.listen_to_action_event(event);
		assert.strictEqual(action.action_event, event);

		const update = (updates: Partial<ActionEventData>): void =>
			event.set_data({ ...event.data, ...updates } as ActionEventDataUnion);

		const big = 'x'.repeat(ACTION_PAYLOAD_BUDGET + 1);
		update({ step: 'handling', progress: big });
		assert.ok(action.pending);
		assert.ok(is_action_payload_omitted(action.action_event_data?.progress));
		assert.strictEqual(event.data.progress, big, 'the event keeps its own data');
		assert.strictEqual(action.action_event, event, 'still listening while pending');

		update({ step: 'handled', output: { show: true } });
		assert.ok(action.success);
		assert.deepEqual(action.action_event_data?.output, { show: true });
		assert.strictEqual(action.action_event, undefined, 'released once complete');
		assert.strictEqual(action.unlisten_to_action_event, undefined);

		// later updates no longer reach the action
		update({ output: { show: false } });
		assert.deepEqual(action.action_event_data?.output, { show: true });
	});
});
