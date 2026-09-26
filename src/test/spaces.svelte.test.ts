// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { SCRATCHPAD_NAME, Spaces } from '$lib/spaces.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

describe('scratchpad', () => {
	test('is created and activated by default', () => {
		const { scratchpad } = app.spaces;
		assert.ok(scratchpad);
		assert.strictEqual(scratchpad.name, SCRATCHPAD_NAME);
		assert.strictEqual(app.spaces.active_id, scratchpad.id);
	});

	test('stays the scratchpad and can not be removed after a rename', () => {
		const scratchpad = app.spaces.ensure_scratchpad();
		scratchpad.name = 'my notes';

		assert.strictEqual(app.spaces.scratchpad, scratchpad);
		app.spaces.remove(scratchpad.id);
		assert.ok(app.spaces.items.has(scratchpad.id));
		assert.strictEqual(app.spaces.ensure_scratchpad(), scratchpad);
		assert.strictEqual(app.spaces.items.size, 1);
	});

	test('another space renamed to the scratchpad name is not protected', () => {
		const scratchpad = app.spaces.ensure_scratchpad();
		const other = app.spaces.add({ name: 'other' });
		other.name = SCRATCHPAD_NAME;

		assert.strictEqual(app.spaces.scratchpad, scratchpad);
		app.spaces.remove(other.id);
		assert.ok(!app.spaces.items.has(other.id));
		assert.ok(app.spaces.items.has(scratchpad.id));
	});

	test('is adopted by name from JSON without a scratchpad id', () => {
		const spaces = new Spaces({ app, json: { items: [{ name: 'a' }, { name: SCRATCHPAD_NAME }] } });
		assert.strictEqual(spaces.items.size, 2);
		assert.strictEqual(spaces.scratchpad?.name, SCRATCHPAD_NAME);
		assert.strictEqual(spaces.scratchpad_id, spaces.scratchpad?.id);
	});

	test('survives replacing the spaces after construction', () => {
		const old_scratchpad = app.spaces.ensure_scratchpad();

		app.spaces.set_json({ items: [{ name: 'a' }, { name: 'b' }] });

		const { scratchpad } = app.spaces;
		assert.ok(scratchpad);
		assert.notStrictEqual(scratchpad, old_scratchpad);
		assert.strictEqual(scratchpad.name, SCRATCHPAD_NAME);
		assert.strictEqual(app.spaces.items.size, 3);
		assert.strictEqual(app.spaces.active_id, scratchpad.id);
		assert.ok(!app.cell_registry.all.has(old_scratchpad.id));

		app.spaces.set_json({ items: [{ name: SCRATCHPAD_NAME }, { name: 'b' }] });
		assert.strictEqual(app.spaces.items.size, 2);
		assert.strictEqual(app.spaces.scratchpad?.name, SCRATCHPAD_NAME);
	});

	test('round-trips through JSON', () => {
		const scratchpad = app.spaces.ensure_scratchpad();
		scratchpad.name = 'renamed';
		const spaces = new Spaces({
			app: monkeypatch_zzz_for_tests(new Frontend()),
			json: app.spaces.json
		});
		assert.strictEqual(spaces.scratchpad?.id, scratchpad.id);
		assert.strictEqual(spaces.scratchpad?.name, 'renamed');
		assert.strictEqual(spaces.items.size, 1);
	});
});

describe('names', () => {
	test('unique names see renamed spaces', () => {
		const space = app.spaces.add({ name: 'first' });
		space.name = 'new space';
		assert.strictEqual(app.spaces.generate_unique_name(), 'new space 2');
		assert.strictEqual(app.spaces.generate_unique_name('first'), 'first');
	});
});

describe('remove', () => {
	test('disposes the space and falls back to the scratchpad', () => {
		const space = app.spaces.add({ name: 'other' });
		app.spaces.activate(space.id);
		assert.ok(app.cell_registry.all.has(space.id));

		app.spaces.remove(space.id);

		assert.ok(!app.cell_registry.all.has(space.id));
		assert.strictEqual(app.spaces.active_id, app.spaces.scratchpad?.id);
	});
});
