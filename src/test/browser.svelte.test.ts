// @vitest-environment jsdom

import { test, describe, assert, beforeEach } from 'vitest';

import { Frontend } from '#lib/frontend.svelte.ts';
import { Browser } from '#routes/tabs/browser.svelte.ts';
import { sample_tabs } from '#routes/tabs/sample_tabs.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('Browser json', () => {
	test('encodes every schema key, `tabs` as the array its decoder takes', () => {
		const browser = new Browser({ app, json: { tabs: sample_tabs } });
		const json = browser.to_json();
		assert.deepEqual(Object.keys(json).sort(), [...browser.schema_keys].sort());
		assert.deepEqual(
			json.tabs,
			browser.tabs.ordered_tabs.map((tab) => tab.to_json())
		);
	});

	test('`set_json(to_json())` round-trips into a fresh browser', () => {
		const browser = new Browser({ app, json: { tabs: sample_tabs } });
		browser.add_new_tab();
		browser.reorder_tab(0, 1);
		browser.browserified = true;
		const json = browser.to_json();

		const restored = new Browser({ app: monkeypatch_zzz_for_tests(new Frontend()), json });
		assert.deepEqual(restored.to_json(), json);
		assert.deepEqual(
			restored.tabs.ordered_tabs.map((tab) => tab.id),
			browser.tabs.ordered_tabs.map((tab) => tab.id)
		);
		assert.strictEqual(restored.tabs.selected_url, browser.tabs.selected_url);
	});

	test('`set_json(to_json())` on the same browser replaces its tabs', () => {
		const browser = new Browser({ app, json: { tabs: sample_tabs } });
		browser.add_new_tab();
		const json = browser.to_json();

		browser.set_json(json);
		assert.strictEqual(browser.tabs.items.size, sample_tabs.length + 1);
		assert.deepEqual(browser.to_json(), json);
	});
});
