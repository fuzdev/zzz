import { describe, test, assert, afterEach, vi } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';

import type {
	FuzTerminalPasteOptions,
	FuzTerminalPasteResult
} from '#lib/fuz_terminal/fuz_terminal_state.svelte.ts';
import { TERMINAL_INPUT_PENDING_MAX_LENGTH } from '#lib/terminal_helpers.ts';
import {
	paste_terminal_text,
	read_clipboard_text,
	to_paste_hazard_question,
	type TerminalPasteDeps
} from '#lib/terminal_paste.ts';

afterEach(() => {
	vi.unstubAllGlobals();
});

interface Recorded {
	deps: TerminalPasteDeps;
	pastes: Array<[string, FuzTerminalPasteOptions | undefined]>;
	questions: Array<string>;
}

/** Deps whose paste answers from `results` in turn, recording what it's asked. */
const create_deps = (
	results: Array<FuzTerminalPasteResult>,
	options: { answer?: boolean; room?: () => number } = {}
): Recorded => {
	const pastes: Recorded['pastes'] = [];
	const questions: Array<string> = [];
	return {
		pastes,
		questions,
		deps: {
			paste: (text, paste_options) => {
				pastes.push([text, paste_options]);
				const result = results.shift();
				assert.ok(result, 'an unexpected paste');
				return result;
			},
			input_room: options.room ?? (() => TERMINAL_INPUT_PENDING_MAX_LENGTH),
			confirm: (message) => {
				questions.push(message);
				return options.answer ?? false;
			}
		}
	};
};

describe('paste_terminal_text', () => {
	test('pastes with the room as the limit, asking nothing', async () => {
		const r = create_deps([{ kind: 'pasted', length: 2 }], { room: () => 100 });
		assert.deepEqual(await paste_terminal_text(Promise.resolve('hi'), r.deps), { kind: 'pasted' });
		assert.deepEqual(r.pastes, [['hi', { max_length: 100 }]]);
		assert.deepEqual(r.questions, []);
	});

	test('a rejected text is asked about with its hazard; declined, it isn’t pasted again', async () => {
		const r = create_deps([{ kind: 'rejected', hazard: 'line_break', bracketed: false }]);
		assert.deepEqual(await paste_terminal_text(Promise.resolve('a\nb'), r.deps), {
			kind: 'declined'
		});
		assert.deepEqual(r.questions, [to_paste_hazard_question('line_break')]);
		assert.strictEqual(r.pastes.length, 1);
	});

	test('confirmed, it’s pasted again allowing that risk, against the room as it is then', async () => {
		let room = 100;
		const r = create_deps(
			[
				{ kind: 'rejected', hazard: 'paste_end', bracketed: true },
				{ kind: 'pasted', length: 3 }
			],
			{ answer: true, room: () => room-- }
		);
		assert.deepEqual(await paste_terminal_text(Promise.resolve('abc'), r.deps), {
			kind: 'pasted'
		});
		assert.deepEqual(r.questions, [to_paste_hazard_question('paste_end')]);
		assert.deepEqual(r.pastes, [
			['abc', { max_length: 100 }],
			['abc', { allow_unsafe: { hazard: 'paste_end', bracketed: true }, max_length: 99 }]
		]);
	});

	test('a confirmed paste whose hazard changed meanwhile is refused, never asked again or read as declined', async () => {
		const r = create_deps(
			[
				{ kind: 'rejected', hazard: 'paste_end', bracketed: true },
				{ kind: 'rejected', hazard: 'line_break', bracketed: false }
			],
			{ answer: true }
		);
		const outcome = await paste_terminal_text(Promise.resolve(`a\n\x1b[201~`), r.deps);
		assert(outcome.kind === 'failed');
		assert.include(outcome.message, "changed the terminal's paste mode while you were asked");
		assert.include(outcome.message, 'nothing was sent');
		assert.deepEqual(r.questions, [to_paste_hazard_question('paste_end')]);
		assert.strictEqual(r.pastes.length, 2);
		assert.deepEqual(r.pastes[1]![1]?.allow_unsafe, { hazard: 'paste_end', bracketed: true });
	});

	test('text longer than the room is refused without pasting or asking', async () => {
		const r = create_deps([], { room: () => 3 });
		const outcome = await paste_terminal_text(Promise.resolve('a\nbc'), r.deps);
		assert(outcome.kind === 'failed');
		assert.include(outcome.message, "it's 4 characters");
		assert.include(outcome.message, 'room for 3 more');
		assert.include(outcome.message, 'nothing was sent');
		assert.deepEqual(r.pastes, []);
		assert.deepEqual(r.questions, []);
	});

	test('each refusal is a message, never a throw', async () => {
		const cases: Array<[FuzTerminalPasteResult, string]> = [
			[{ kind: 'empty' }, 'paste failed: the clipboard has no text'],
			[
				{ kind: 'too_large', length: TERMINAL_INPUT_PENDING_MAX_LENGTH + 12 },
				`paste refused: it's ${TERMINAL_INPUT_PENDING_MAX_LENGTH + 12} characters, and a terminal takes at most ${TERMINAL_INPUT_PENDING_MAX_LENGTH} characters of input at a time — nothing was sent`
			],
			[
				{ kind: 'unavailable', reason: 'input_off' },
				'paste failed: the terminal takes no input now'
			],
			[{ kind: 'unavailable', reason: 'busy' }, "paste failed: the terminal view isn't ready"],
			[{ kind: 'unavailable', reason: 'not_ready' }, "paste failed: the terminal view isn't ready"]
		];
		for (const [result, message] of cases) {
			const r = create_deps([result]);
			assert.deepEqual(await paste_terminal_text(Promise.resolve('x'), r.deps), {
				kind: 'failed',
				message
			});
		}
	});

	test('a failed or empty read pastes nothing', async () => {
		const denied = create_deps([]);
		const outcome = await paste_terminal_text(
			Promise.reject(new DOMException('', 'NotAllowedError')),
			denied.deps
		);
		assert.deepEqual(outcome, {
			kind: 'failed',
			message: "paste failed: the browser didn't allow reading the clipboard"
		});
		const broken = await paste_terminal_text(Promise.reject(new Error('gone')), denied.deps);
		assert.deepEqual(broken, {
			kind: 'failed',
			message: "paste failed: couldn't read the clipboard: gone"
		});
		const empty = await paste_terminal_text(Promise.resolve(''), denied.deps);
		assert.deepEqual(empty, { kind: 'failed', message: 'paste failed: the clipboard has no text' });
		assert.deepEqual(denied.pastes, []);
	});
});

describe('read_clipboard_text', () => {
	test('reads through navigator.clipboard', async () => {
		vi.stubGlobal('navigator', { clipboard: { readText: () => Promise.resolve('copied') } });
		assert.strictEqual(await read_clipboard_text(), 'copied');
	});

	test('rejects, never throws, without clipboard access or when the read throws', async () => {
		vi.stubGlobal('navigator', {});
		const missing = await assert_rejects(() => read_clipboard_text());
		assert.include(missing.message, 'secure context');
		vi.stubGlobal('navigator', {
			clipboard: {
				readText: () => {
					throw new Error('sync throw');
				}
			}
		});
		const thrown = await assert_rejects(() => read_clipboard_text());
		assert.strictEqual(thrown.message, 'sync throw');
	});
});
