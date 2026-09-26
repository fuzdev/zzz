// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Part } from '$lib/part.svelte.ts';
import type { Prompt } from '$lib/prompt.svelte.ts';
import { DiskfilePath } from '$lib/diskfile_types.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
});

/** Selects `prompt` then leaves the prompts route, as navigating elsewhere does. */
const select_then_leave = (prompt: Prompt): void => {
	app.prompts.selected_id = prompt.id;
	app.prompts.selected_id = null;
};

describe('removing the last selected prompt off its route', () => {
	test('`remove` forgets it, so nav links stop pointing at it', () => {
		const prompt = app.prompts.add();
		select_then_leave(prompt);
		assert.strictEqual(app.prompts.selected_id_last_non_null, prompt.id);

		app.prompts.remove(prompt);

		assert.strictEqual(app.prompts.selected_id_last_non_null, null);
		assert.ok(!app.prompts.items.has(prompt.id));
	});

	test('`remove_many` forgets it and keeps it when another prompt is removed', () => {
		const prompt = app.prompts.add();
		const other = app.prompts.add();
		select_then_leave(prompt);

		app.prompts.remove_many([other.id]);
		assert.strictEqual(app.prompts.selected_id_last_non_null, prompt.id);

		app.prompts.remove_many([prompt.id]);
		assert.strictEqual(app.prompts.selected_id_last_non_null, null);
	});
});

describe('Prompts.filter_by_diskfile_path', () => {
	test('matches prompts by the path of their own diskfile parts', () => {
		const path = DiskfilePath.parse('/test/notes.txt');
		const with_file = app.prompts.add();
		with_file.add_part(Part.create(app, { type: 'diskfile', path }));
		const with_text = app.prompts.add();
		with_text.add_part(Part.create(app, { type: 'text', content: '/test/notes.txt' }));
		const with_other_file = app.prompts.add();
		with_other_file.add_part(
			Part.create(app, { type: 'diskfile', path: DiskfilePath.parse('/test/other.txt') })
		);

		assert.deepEqual(app.prompts.filter_by_diskfile_path(path), [with_file]);
	});
});
