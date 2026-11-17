import { test, assert } from 'vitest';

import { Frontend } from '#lib/frontend.svelte.ts';
import { model_sorters, type ModelJsonInput } from '#lib/model.svelte.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const MODELS: Array<ModelJsonInput> = [
	{ name: 'gpt_b', provider_name: 'chatgpt' },
	{ name: 'claude_b', provider_name: 'claude' },
	{ name: 'gpt_a', provider_name: 'chatgpt' },
	{ name: 'gemini_a', provider_name: 'gemini' },
	{ name: 'claude_a', provider_name: 'claude' },
	{ name: 'gpt_c', provider_name: 'chatgpt' }
];

/** Loads `MODELS` into a fresh app, as a reload does, and sorts them by `key`. */
const load_and_sort = (key: string): Array<string> => {
	const app = monkeypatch_zzz_for_tests(new Frontend({ models: MODELS }));
	const sorter = model_sorters.find((s) => s.key === key);
	assert.ok(sorter, key);
	return app.models.ordered_by_name
		.slice()
		.sort(sorter.fn)
		.map((model) => model.name);
};

test('the provider orders tie on name, so a reload gives the same order', () => {
	const asc = ['gpt_a', 'gpt_b', 'gpt_c', 'claude_a', 'claude_b', 'gemini_a'];
	const desc = ['gemini_a', 'claude_a', 'claude_b', 'gpt_a', 'gpt_b', 'gpt_c'];
	// each load gives the models new random ids, which no longer decide the order
	for (let i = 0; i < 5; i++) {
		assert.deepEqual(load_and_sort('provider_asc'), asc);
		assert.deepEqual(load_and_sort('provider_desc'), desc);
	}
});
