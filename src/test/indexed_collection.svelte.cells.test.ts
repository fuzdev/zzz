// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { DiskfilePath } from '$lib/diskfile_types.ts';
import type { DiskfilePart } from '$lib/part.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(
		new Frontend({
			models: [
				{ name: 'model_a', provider_name: 'claude' },
				{ name: 'model_b', provider_name: 'claude' }
			]
		})
	);
});

describe('name indexes follow renames', () => {
	test('chats', () => {
		const chat = app.chats.add({ name: 'first' });
		chat.name = 'new chat';

		assert.strictEqual(app.chats.generate_unique_name(), 'new chat 2');
		assert.strictEqual(app.chats.generate_unique_name('first'), 'first');
		assert.strictEqual(app.chats.add().name, 'new chat 2');
	});

	test('prompts', () => {
		const prompt = app.prompts.add({ name: 'first' });
		prompt.name = 'new prompt';

		assert.strictEqual(app.prompts.generate_unique_name(), 'new prompt 2');
		assert.strictEqual(app.prompts.generate_unique_name('first'), 'first');
	});

	test('parts', () => {
		const part = app.parts.add({ type: 'text', name: 'first' });
		part.name = 'new part';

		assert.strictEqual(app.parts.generate_unique_name(), 'new part 2');
		assert.strictEqual(app.parts.generate_unique_name('first'), 'first');
	});
});

describe('other mutable-key indexes', () => {
	test("a model's provider follows a provider change", () => {
		const model = app.models.find_by_name('model_b')!;
		const names_by_provider = (provider_name: string) =>
			app.models.items.where('provider_name', provider_name).map((m) => m.name);
		assert.deepEqual(names_by_provider('claude'), ['model_a', 'model_b']);

		model.provider_name = 'chatgpt';

		assert.deepEqual(names_by_provider('claude'), ['model_a']);
		assert.deepEqual(names_by_provider('chatgpt'), ['model_b']);
	});

	test("a diskfile part is found by its new path after it's repointed", () => {
		const path_a = DiskfilePath.parse('/ws/a.txt');
		const path_b = DiskfilePath.parse('/ws/b.txt');
		const part = app.parts.add({ type: 'diskfile', path: path_a }) as DiskfilePart;
		assert.strictEqual(app.parts.find_part_by_diskfile_path(path_a), part);

		part.path = path_b;

		assert.isUndefined(app.parts.find_part_by_diskfile_path(path_a));
		assert.strictEqual(app.parts.find_part_by_diskfile_path(path_b), part);
	});
});

describe('removal disposes', () => {
	test('a removed chat leaves the cell registry', () => {
		const chat = app.chats.add({ name: 'chat' });
		assert.ok(app.cell_registry.all.has(chat.id));

		app.chats.remove(chat.id);

		assert.ok(!app.cell_registry.all.has(chat.id));
	});

	test('a removed part leaves the cell registry', () => {
		const part = app.parts.add({ type: 'text', content: 'x' });
		assert.ok(app.parts.remove(part.id));
		assert.ok(!app.cell_registry.all.has(part.id));
	});

	test('a removed prompt disposes its parts, and so does removing a part', () => {
		const prompt = app.prompts.add({
			name: 'prompt',
			parts: [
				{ type: 'text', content: 'a' },
				{ type: 'text', content: 'b' },
				{ type: 'text', content: 'c' }
			]
		});
		const [a, b, c] = prompt.parts;
		assert.ok(a && b && c);
		assert.ok(app.cell_registry.all.has(a.id));

		assert.ok(prompt.remove_part(a.id));
		assert.ok(!app.cell_registry.all.has(a.id));
		assert.ok(app.cell_registry.all.has(b.id));

		app.prompts.selected_id = null; // removing the selected prompt navigates
		app.prompts.remove(prompt);
		assert.ok(!app.cell_registry.all.has(prompt.id));
		assert.ok(!app.cell_registry.all.has(b.id));
		assert.ok(!app.cell_registry.all.has(c.id));
	});

	test('re-decoding a collection disposes the replaced items', () => {
		const chat = app.chats.add({ name: 'old' });
		app.chats.set_json({ items: [{ name: 'new' }] });

		assert.ok(!app.cell_registry.all.has(chat.id));
		assert.deepEqual(
			app.chats.items.values.map((c) => c.name),
			['new']
		);
	});
});
