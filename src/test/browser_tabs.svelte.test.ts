// @vitest-environment jsdom

import { test, describe, assert, beforeEach } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { BROWSER_TABS_CLOSED_MAX, BrowserTabs } from '$routes/tabs/browser_tabs.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;
let tabs: BrowserTabs;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	tabs = new BrowserTabs({ app });
});

describe('BrowserTabs.reopen_last_closed_tab', () => {
	test('reopens a live, registered cell, not the disposed one', () => {
		tabs.add_new_tab();
		const closed = tabs.ordered_tabs[0]!;
		closed.title = 'edited';
		assert.ok(app.cell_registry.all.has(closed.id));

		tabs.close(0);
		assert.ok(!app.cell_registry.all.has(closed.id), 'closing disposes the cell');

		tabs.reopen_last_closed_tab();

		const reopened = tabs.ordered_tabs[0];
		assert.ok(reopened);
		assert.notStrictEqual(reopened, closed);
		assert.strictEqual(reopened.id, closed.id);
		assert.strictEqual(reopened.title, 'edited');
		assert.ok(reopened.selected);
		assert.ok(
			app.cell_registry.all.get(reopened.id) === (reopened as unknown),
			'the reopened cell is registered'
		);
		assert.deepEqual(tabs.recently_closed_tabs, []);
	});

	test('does nothing with nothing closed', () => {
		tabs.reopen_last_closed_tab();
		assert.strictEqual(tabs.items.size, 0);
	});

	test('keeps at most `BROWSER_TABS_CLOSED_MAX` closed tabs, the newest', () => {
		let last_id = null;
		for (let i = 0; i < BROWSER_TABS_CLOSED_MAX + 10; i++) {
			tabs.add_new_tab();
			last_id = tabs.ordered_tabs[0]!.id;
			tabs.close(0);
		}
		assert.strictEqual(tabs.recently_closed_tabs.length, BROWSER_TABS_CLOSED_MAX);
		assert.strictEqual(tabs.recently_closed_tabs.at(-1)?.id, last_id);
	});
});
