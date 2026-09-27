// @vitest-environment jsdom

import { test, describe, beforeEach, assert } from 'vitest';

import { Frontend } from '$lib/frontend.svelte.ts';
import { Thread } from '$lib/thread.svelte.ts';
import { Turn } from '$lib/turn.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '$lib/diskfile_types.ts';
import { estimate_token_count } from '$lib/helpers.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const SOURCE_DIR = SerializableDisknode.shape.source_dir.parse('/w/');
const LOADED_PATH = DiskfilePath.parse('/w/loaded.ts');
const UNLOADED_PATH = DiskfilePath.parse('/w/big.bin');
const MISSING_PATH = DiskfilePath.parse('/w/missing.ts');

let app: Frontend;
let thread: Thread;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(
		new Frontend({ models: [{ name: 'test-model', provider_name: 'claude' }] })
	);
	thread = app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));
	app.diskfiles.add({ path: LOADED_PATH, source_dir: SOURCE_DIR, content: 'const a = 1;' });
	// content not loaded — the part's content is `null`
	app.diskfiles.add({ path: UNLOADED_PATH, source_dir: SOURCE_DIR, content: null });
});

const add_turn = (
	role: 'user' | 'assistant',
	parts: Array<{ type: 'text'; content: string } | { type: 'diskfile'; path: DiskfilePath }>
): Turn => {
	const part_ids = parts.map((json) => app.parts.add(json).id);
	const turn = new Turn({ app, json: { role, part_ids } });
	thread.add_turn(turn);
	return turn;
};

const assert_lengths_match = (): void => {
	for (const turn of thread.turns.values) {
		assert.strictEqual(turn.length, turn.content.length, `turn ${turn.id}`);
		assert.strictEqual(turn.token_count, estimate_token_count(turn.content));
	}
	assert.strictEqual(thread.length, thread.content.length);
	assert.strictEqual(thread.token_count, estimate_token_count(thread.content));
};

describe('Turn and Thread lengths', () => {
	test('match their content across part kinds and disabled turns', () => {
		const with_files = add_turn('user', [
			{ type: 'text', content: 'look at these' },
			{ type: 'diskfile', path: LOADED_PATH },
			{ type: 'diskfile', path: UNLOADED_PATH },
			{ type: 'diskfile', path: MISSING_PATH },
			{ type: 'text', content: '' }
		]);
		add_turn('assistant', [{ type: 'text', content: 'sure' }]);
		const disabled = add_turn('user', [{ type: 'text', content: 'never mind' }]);
		disabled.enabled = false;
		add_turn('assistant', [{ type: 'text', content: '' }]);

		assert.deepEqual(
			with_files.parts.map((part) => part.content),
			['look at these', 'const a = 1;', null, undefined, ''],
			'covers loaded, not loaded, missing, and empty parts'
		);
		assert.ok(thread.content.includes('look at these'));
		assert.ok(!thread.content.includes('never mind'), 'the disabled turn is skipped');
		assert_lengths_match();
	});

	test('track streamed content and re-enabled turns', () => {
		add_turn('user', [{ type: 'text', content: 'hi' }]);
		const reply = add_turn('assistant', [{ type: 'text', content: '' }]);
		assert_lengths_match();

		reply.append_completion_text('Hello');
		reply.append_completion_text(', there.');
		assert_lengths_match();
		assert.strictEqual(reply.length, 'Hello, there.'.length);

		reply.enabled = false;
		assert_lengths_match();
		reply.enabled = true;
		assert_lengths_match();
	});

	test('an empty thread has no length', () => {
		assert.strictEqual(thread.length, 0);
		assert.strictEqual(thread.token_count, 0);
		assert_lengths_match();
	});
});
