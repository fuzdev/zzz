// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Actions } from '$lib/actions.svelte.ts';
import type { Action } from '$lib/action.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('history trimming', () => {
	test('trimmed actions are disposed, stop listening, and leave the registry', () => {
		const actions = new Actions({ app, history_limit: 2 });
		const added: Array<Action> = [];
		let unlistened = 0;
		for (let i = 0; i < 3; i++) {
			const action = actions.add_from_json({ method: 'ping' });
			action.unlisten_to_action_event = () => {
				unlistened++;
			};
			added.push(action);
		}
		const [oldest, second, newest] = added;
		assert.ok(oldest && second && newest);

		assert.strictEqual(actions.items.size, 2);
		assert.ok(!actions.items.has(oldest.id));
		assert.ok(!app.cell_registry.all.has(oldest.id));
		assert.strictEqual(unlistened, 1);
		assert.ok(app.cell_registry.all.has(second.id));
		assert.ok(app.cell_registry.all.has(newest.id));
		assert.deepEqual(
			actions.items.values.map((a) => a.id),
			[second.id, newest.id]
		);
	});
});
