// @vitest-environment jsdom

import { describe, test, assert, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { get_datetime_now } from '@fuzdev/fuz_util/datetime.ts';

import TurnListitem from '$lib/TurnListitem.svelte';
import { Frontend } from '$lib/frontend.svelte.ts';
import { Thread } from '$lib/thread.svelte.ts';
import type { Turn } from '$lib/turn.svelte.ts';
import type { CompletionResponse } from '$lib/completion_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

const create_turn = (): { app: Frontend; turn: Turn } => {
	const app = monkeypatch_zzz_for_tests(new Frontend());
	const thread = app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));
	thread.add_user_turn('q');
	return { app, turn: thread.add_assistant_turn('partial reply') };
};

const create_claude_response = (stop_reason: string): CompletionResponse => ({
	created: get_datetime_now(),
	provider_name: 'claude',
	model: 'test-model',
	data: {
		type: 'claude',
		value: { content: [{ type: 'text', text: 'partial reply' }], stop_reason }
	}
});

/** Mounts `TurnListitem` for `turn` and returns its rendered text. */
const render_text = (app: Frontend, turn: Turn): string => {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(FrontendContextHarness, {
		target,
		props: { app, component: TurnListitem, props: { turn } }
	});
	flushSync();
	cleanup = () => {
		void unmount(component);
		target.remove();
	};
	return target.textContent;
};

describe('TurnListitem', () => {
	test('notes a truncated reply', () => {
		const { app, turn } = create_turn();
		turn.response = create_claude_response('max_tokens');
		const text = render_text(app, turn);
		assert.include(text, 'partial reply');
		assert.include(text, 'truncated (max tokens)');
	});

	test('labels a reply cut off by the context window', () => {
		const { app, turn } = create_turn();
		turn.response = create_claude_response('model_context_window_exceeded');
		const text = render_text(app, turn);
		assert.include(text, 'truncated (context window)');
		assert.notInclude(text, 'max tokens');
	});

	test('shows an error instead of the truncation note', () => {
		const { app, turn } = create_turn();
		turn.response = create_claude_response('max_tokens');
		assert.ok(turn.truncated);
		turn.error_message = 'claude: the model declined to respond (stop_reason: refusal)';
		const text = render_text(app, turn);
		assert.include(text, 'partial reply');
		assert.include(text, 'declined to respond');
		assert.notInclude(text, 'truncated');
	});

	test('shows no note for a finished reply', () => {
		const { app, turn } = create_turn();
		turn.response = {
			created: get_datetime_now(),
			provider_name: 'chatgpt',
			model: 'test-model',
			data: {
				type: 'chatgpt',
				value: { choices: [{ message: { content: 'partial reply' }, finish_reason: 'stop' }] }
			}
		};
		const text = render_text(app, turn);
		assert.notInclude(text, 'truncated');
	});
});
