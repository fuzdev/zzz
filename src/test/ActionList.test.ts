// @vitest-environment jsdom

import { describe, test, assert, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import ActionList from '$lib/ActionList.svelte';
import type { Action } from '$lib/action.svelte.ts';
import { Frontend } from '$lib/frontend.svelte.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

/** Mounts `ActionList` and returns the actions its rendered items select. */
const mount_listed_actions = (app: Frontend, limit: number): Set<Action> => {
	const selected: Set<Action> = new Set();
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(FrontendContextHarness, {
		target,
		props: {
			app,
			component: ActionList,
			props: { limit, onselect: (a: Action) => selected.add(a) }
		}
	});
	flushSync();
	cleanup = () => {
		void unmount(component);
		target.remove();
	};
	for (const button of target.querySelectorAll('button')) button.click();
	return selected;
};

describe('ActionList', () => {
	test('shows the newest actions past the limit', () => {
		const app = new Frontend();
		const actions: Array<Action> = [];
		for (let i = 0; i < 30; i++) actions.push(app.actions.add_from_json({ method: 'ping' }));

		const listed = mount_listed_actions(app, 10);

		assert.strictEqual(listed.size, 10);
		for (const action of actions.slice(-10)) assert.ok(listed.has(action));
		assert.ok(!listed.has(actions[0]!));
	});

	test('shows every action under the limit', () => {
		const app = new Frontend();
		const actions = [0, 1, 2].map(() => app.actions.add_from_json({ method: 'ping' }));

		const listed = mount_listed_actions(app, 10);

		assert.strictEqual(listed.size, 3);
		for (const action of actions) assert.ok(listed.has(action));
	});
});
