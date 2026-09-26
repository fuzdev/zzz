// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { TERMINAL_PRESETS_DEFAULT, TerminalPresets } from '$lib/terminal_presets.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('TerminalPresets', () => {
	test('the app seeds the default presets once', () => {
		const names = app.terminal_presets.items.values.map((p) => p.name);
		assert.deepEqual(
			names,
			TERMINAL_PRESETS_DEFAULT.map((p) => p.name)
		);
	});

	test('constructing with items skips the defaults', () => {
		const presets = new TerminalPresets({
			app,
			json: { items: [{ name: 'mine', command: 'ls' }] }
		});
		assert.deepEqual(
			presets.items.values.map((p) => p.name),
			['mine']
		);
	});

	test('added presets are registered and removal disposes them', () => {
		const preset = app.terminal_presets.add({ name: 'x', command: 'ls', args: ['-la'] });
		assert.ok(app.cell_registry.all.has(preset.id));
		assert.ok(app.terminal_presets.items.has(preset.id));

		assert.ok(app.terminal_presets.remove(preset.id));
		assert.ok(!app.terminal_presets.items.has(preset.id));
		assert.ok(!app.cell_registry.all.has(preset.id));
		assert.ok(!app.terminal_presets.remove(preset.id));
	});

	test('clear disposes every preset', () => {
		const ids = app.terminal_presets.items.values.map((p) => p.id);
		app.terminal_presets.clear();
		assert.strictEqual(app.terminal_presets.items.size, 0);
		for (const id of ids) {
			assert.ok(!app.cell_registry.all.has(id));
		}
	});
});
