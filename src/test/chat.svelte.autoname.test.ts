// @vitest-environment jsdom

import { test, describe, beforeEach, assert, vi } from 'vitest';
import { get_datetime_now } from '@fuzdev/fuz_util/datetime.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { Frontend } from '$lib/frontend.svelte.ts';
import { CHAT_AUTONAME_ATTEMPTS_MAX, type Chat } from '$lib/chat.svelte.ts';
import { Turn } from '$lib/turn.svelte.ts';
import type { CompletionResponse } from '$lib/completion_types.ts';
import { BOTS_DEFAULT } from '$lib/config_defaults.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const NAMER = BOTS_DEFAULT.namerbot;

type NamerReply =
	{ ok: true; name: string } | { ok: false; code: number; message: string; data?: unknown };

let app: Frontend;
let namer_replies: Array<NamerReply>;
let namer_calls: number;
/** Resolves the next namer request; set while one is held in flight. */
let hold_namer: Promise<void> | null;
/** Held back until resolved: replies for threads on model `m_slow`. */
let hold_slow: Promise<void> | null;

const create_claude_response = (text: string): CompletionResponse => ({
	created: get_datetime_now(),
	provider_name: 'claude',
	model: 'm',
	data: { type: 'claude', value: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } }
});

beforeEach(() => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	app = monkeypatch_zzz_for_tests(
		new Frontend({
			models: [
				{ name: 'm', provider_name: 'claude' },
				{ name: 'm_slow', provider_name: 'claude' },
				{ name: NAMER, provider_name: 'claude' }
			]
		})
	);
	namer_replies = [];
	namer_calls = 0;
	hold_namer = null;
	hold_slow = null;
	(app as unknown as { api: unknown }).api = {
		completion_create: async (input: {
			completion_request: { model: string };
			_meta?: { progressToken: Uuid };
		}) => {
			if (input.completion_request.model === NAMER) {
				namer_calls++;
				if (hold_namer) await hold_namer;
				const reply = namer_replies.shift() ?? { ok: true, name: 'named' };
				return reply.ok
					? { ok: true, value: { completion_response: create_claude_response(reply.name) } }
					: { ok: false, error: { code: reply.code, message: reply.message, data: reply.data } };
			}
			if (input.completion_request.model === 'm_slow' && hold_slow) await hold_slow;
			// the chat's own completion: settle the assistant turn with a reply
			const turn = app.cell_registry.all.get(input._meta!.progressToken);
			assert(turn instanceof Turn);
			turn.set_completion_text('reply');
			turn.response = create_claude_response('reply');
			return { ok: true, value: {} };
		}
	};
});

const create_chat = (name?: string): Chat => {
	const chat = app.chats.add(name === undefined ? undefined : { name });
	chat.add_thread(app.models.find_by_name('m')!);
	return chat;
};

/** Sends to the chat's first thread and lets auto-naming finish. */
const send = async (chat: Chat): Promise<void> => {
	await chat.send_to_thread(chat.thread_ids[0]!, 'hello');
	await new Promise((r) => setTimeout(r, 0));
};

const transient = (message = 'claude: Overloaded'): NamerReply => ({
	ok: false,
	code: JSONRPC_ERROR_CODES.internal_error,
	message
});

/** A provider failure for a non-2xx upstream response, as the backend sends it. */
const http_error = (status: number): NamerReply => ({
	ok: false,
	code: JSONRPC_ERROR_CODES.internal_error,
	message: `claude: upstream ${status}`,
	data: { reason: 'provider_http_error', status }
});

describe('Chat auto-naming', () => {
	test('names a new chat once, then leaves the name alone', async () => {
		const chat = create_chat();
		assert.ok(chat.autoname);
		namer_replies.push({ ok: true, name: 'greetings' });
		await send(chat);
		assert.strictEqual(chat.name, 'greetings');
		assert.ok(!chat.autoname);
		assert.strictEqual(chat.init_name_status, 'success');

		await send(chat);
		assert.strictEqual(namer_calls, 1);
		assert.strictEqual(chat.name, 'greetings');
	});

	test('retries a transient failure on later sends, then gives up', async () => {
		const chat = create_chat();
		for (let i = 0; i < CHAT_AUTONAME_ATTEMPTS_MAX + 2; i++) namer_replies.push(transient());
		for (let i = 0; i < CHAT_AUTONAME_ATTEMPTS_MAX + 2; i++) await send(chat);

		assert.strictEqual(namer_calls, CHAT_AUTONAME_ATTEMPTS_MAX);
		assert.strictEqual(chat.init_name_status, 'failure');
		assert.strictEqual(chat.init_name_error, 'claude: Overloaded');
		assert.strictEqual(chat.name, 'new chat');
	});

	test('a retry after a transient failure can still succeed', async () => {
		const chat = create_chat();
		namer_replies.push(transient(), { ok: true, name: 'second try' });
		await send(chat);
		assert.strictEqual(chat.init_name_status, 'initial');
		assert.strictEqual(chat.init_name_error, 'claude: Overloaded');
		await send(chat);
		assert.strictEqual(chat.name, 'second try');
		assert.strictEqual(chat.init_name_error, null);
	});

	test('stops after one permanent failure', async () => {
		for (const code of [
			JSONRPC_ERROR_CODES.invalid_params,
			JSONRPC_ERROR_CODES.not_found,
			JSONRPC_ERROR_CODES.unauthenticated,
			JSONRPC_ERROR_CODES.forbidden
		]) {
			namer_calls = 0;
			const chat = create_chat();
			namer_replies.push({ ok: false, code, message: 'nope' });
			await send(chat);
			await send(chat);
			assert.strictEqual(namer_calls, 1, `code ${code}`);
			assert.strictEqual(chat.init_name_status, 'failure');
			assert.strictEqual(chat.init_name_error, 'nope');
		}
	});

	test('stops after one upstream 400, 401, 403, or 404', async () => {
		for (const status of [400, 401, 403, 404]) {
			namer_calls = 0;
			const chat = create_chat();
			namer_replies.push(http_error(status));
			await send(chat);
			await send(chat);
			assert.strictEqual(namer_calls, 1, `status ${status}`);
			assert.strictEqual(chat.init_name_status, 'failure');
			assert.strictEqual(chat.init_name_error, `claude: upstream ${status}`);
		}
	});

	test('retries an upstream 408, 429, or 5xx on the next send', async () => {
		for (const status of [408, 429, 500, 503, 529]) {
			namer_calls = 0;
			const chat = create_chat();
			namer_replies.push(http_error(status), { ok: true, name: `named ${status}` });
			await send(chat);
			assert.strictEqual(chat.init_name_status, 'initial', `status ${status}`);
			await send(chat);
			assert.strictEqual(namer_calls, 2, `status ${status}`);
			assert.strictEqual(chat.name, `named ${status}`);
		}
	});

	test('makes at most one naming attempt per send across threads', async () => {
		const chat = create_chat();
		chat.add_thread(app.models.find_by_name('m_slow')!);
		chat.add_thread(app.models.find_by_name('m_slow')!);
		for (let i = 0; i < CHAT_AUTONAME_ATTEMPTS_MAX; i++) namer_replies.push(transient());

		// the fast thread's reply triggers naming, which fails before the slow threads reply
		let release_slow!: () => void;
		hold_slow = new Promise((r) => (release_slow = r));
		const sent = chat.send_to_all('hello');
		await new Promise((r) => setTimeout(r, 0));
		assert.strictEqual(namer_calls, 1);
		assert.strictEqual(chat.init_name_status, 'initial');
		release_slow();
		assert.strictEqual(await sent, 3);
		await new Promise((r) => setTimeout(r, 0));
		assert.strictEqual(namer_calls, 1, 'the slow replies of the same send do not retry');

		hold_slow = null;
		await chat.send_to_all('again');
		await new Promise((r) => setTimeout(r, 0));
		assert.strictEqual(namer_calls, 2, 'the next send retries once');
	});

	test('renaming clears a naming failure, and later failures are not recorded', async () => {
		const chat = create_chat();
		namer_replies.push(transient());
		await send(chat);
		assert.strictEqual(chat.init_name_error, 'claude: Overloaded');
		chat.rename('mine');
		assert.strictEqual(chat.init_name_error, null);

		// a failure landing after a rename made mid-request
		const other = create_chat();
		let release!: () => void;
		hold_namer = new Promise((r) => (release = r));
		namer_replies.push(transient());
		const sent = send(other);
		await new Promise((r) => setTimeout(r, 0));
		other.rename('also mine');
		release();
		await sent;
		await new Promise((r) => setTimeout(r, 0));
		assert.strictEqual(other.init_name_error, null);
		assert.strictEqual(other.init_name_attempts, 0);
		assert.strictEqual(other.name, 'also mine');
	});

	test('an empty naming reply counts as a failed attempt', async () => {
		const chat = create_chat();
		namer_replies.push({ ok: true, name: '  ' });
		await send(chat);
		assert.strictEqual(chat.name, 'new chat');
		assert.strictEqual(chat.init_name_attempts, 1);
		assert.strictEqual(chat.init_name_status, 'initial');
	});

	test('never renames a chat the user renamed', async () => {
		const chat = create_chat();
		chat.rename('my chat');
		assert.ok(!chat.autoname);
		await send(chat);
		assert.strictEqual(namer_calls, 0);
		assert.strictEqual(chat.name, 'my chat');
	});

	test('keeps a rename made while naming is in flight', async () => {
		const chat = create_chat();
		let release!: () => void;
		hold_namer = new Promise((r) => (release = r));
		const sent = send(chat);
		await new Promise((r) => setTimeout(r, 0));
		assert.strictEqual(namer_calls, 1);
		chat.rename('mine');
		release();
		await sent;
		await new Promise((r) => setTimeout(r, 0));
		assert.strictEqual(chat.name, 'mine');
	});

	test('renaming to the same name keeps auto-naming on', () => {
		const chat = create_chat();
		chat.rename(chat.name);
		assert.ok(chat.autoname);
	});

	test('a chat added with a name is not auto-named', async () => {
		const chat = create_chat('project notes');
		assert.ok(!chat.autoname);
		await send(chat);
		assert.strictEqual(namer_calls, 0);
		assert.strictEqual(chat.name, 'project notes');
	});

	test('autoname round-trips through json', () => {
		const chat = create_chat();
		chat.rename('x');
		const restored = app.chats.add(chat.json);
		assert.ok(!restored.autoname);
		const fresh = app.chats.add({ ...create_chat().json, name: 'y', autoname: true });
		assert.ok(fresh.autoname);
	});

	test('a duplicate keeps its name when the original was named', async () => {
		const chat = create_chat();
		namer_replies.push({ ok: true, name: 'original' });
		await send(chat);
		const duplicate = app.chats.duplicate(chat);
		assert.strictEqual(duplicate.name, 'original 2');
		assert.ok(!duplicate.autoname);
		await send(duplicate);
		assert.strictEqual(namer_calls, 1);
		assert.strictEqual(duplicate.name, 'original 2');
	});

	test('a duplicate of a default-named chat can still be auto-named', async () => {
		const duplicate = app.chats.duplicate(create_chat());
		assert.ok(duplicate.autoname);
		namer_replies.push({ ok: true, name: 'fresh name' });
		await send(duplicate);
		assert.strictEqual(duplicate.name, 'fresh name');
	});
});
