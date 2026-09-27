import { test, describe, assert } from 'vitest';

import {
	joined_content_length,
	render_message_with_role,
	render_message_with_role_length,
	render_messages_length,
	render_messages_to_string
} from '$lib/thread_helpers.ts';
import type { CompletionRole } from '$lib/completion_types.ts';

interface TestTurn {
	role: CompletionRole;
	content: string;
	length: number;
	enabled?: boolean;
}

const create_turn = (role: CompletionRole, content: string, enabled?: boolean): TestTurn => ({
	role,
	content,
	length: content.length,
	enabled
});

describe('render_message_with_role_length', () => {
	test('matches the rendered length', () => {
		for (const tag of ['message', 'x']) {
			for (const content of ['', 'hi', 'a longer message\nwith lines']) {
				assert.strictEqual(
					render_message_with_role_length('assistant', content.length, tag),
					render_message_with_role('assistant', content, tag).length
				);
			}
		}
	});
});

describe('render_messages_length', () => {
	test('matches render_messages_to_string', () => {
		const cases: Array<Array<TestTurn>> = [
			[],
			[create_turn('user', 'hello')],
			[create_turn('user', 'hello'), create_turn('assistant', 'hi there')],
			[
				create_turn('user', 'a', false),
				create_turn('assistant', ''),
				create_turn('user', 'third'),
				create_turn('assistant', 'skipped', false)
			],
			[create_turn('user', 'x', false)]
		];
		for (const turns of cases) {
			assert.strictEqual(render_messages_length(turns), render_messages_to_string(turns).length);
			assert.strictEqual(
				render_messages_length(turns, 'm'),
				render_messages_to_string(turns, 'm').length
			);
		}
	});
});

describe('joined_content_length', () => {
	test('matches joining the non-null contents with blank lines', () => {
		const cases: Array<Array<string | null | undefined>> = [
			[],
			['abc'],
			['abc', 'de'],
			[null, 'abc', undefined, 'de', ''],
			[null, undefined]
		];
		for (const contents of cases) {
			assert.strictEqual(
				joined_content_length(contents.map((c) => c?.length)),
				contents.filter((c) => c != null).join('\n\n').length
			);
		}
	});
});
