// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, describe, beforeEach, assert, vi } from 'vitest';

import { Frontend } from '#lib/frontend.svelte.ts';
import { Thread } from '#lib/thread.svelte.ts';
import { Turn } from '#lib/turn.svelte.ts';
import { create_deferred } from '@fuzdev/fuz_util/async.ts';
import type { CompletionRequest } from '#lib/completion_types.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import { create_frontend_action_handlers } from '#lib/frontend_action_handlers.ts';
import type { FrontendActionHandlers } from '#lib/frontend_action_types.ts';

import {
	FrontendWebsocketTransport,
	type WebsocketRpcConnection
} from '@fuzdev/fuz_app/actions/transports_ws.ts';
import { JSONRPC_ERROR_CODES, ThrownJsonrpcError } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

/** A stubbed `completion_create` call, resolved manually by the test. */
interface StubbedCall {
	completion_request: CompletionRequest;
	signal: AbortSignal | undefined;
	resolve: () => void;
}

let app: Frontend;
let calls: Array<StubbedCall>;

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/test/');
const FILE_PATH = parse_or_throw(DiskfilePath, '/test/notes.txt');

/**
 * Replaces `app.api` with a stub whose `completion_create` stays in flight until
 * the test resolves it — or until the caller aborts, mirroring the WS client.
 */
const stub_api = (target: Frontend): void => {
	(target as unknown as { api: unknown }).api = {
		completion_create: (
			input: { completion_request: CompletionRequest },
			options?: { signal?: AbortSignal }
		) =>
			new Promise<void>((resolve) => {
				calls.push({
					completion_request: input.completion_request,
					signal: options?.signal,
					resolve
				});
				options?.signal?.addEventListener('abort', () => resolve());
			})
	};
};

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(
		new Frontend({ models: [{ name: 'test-model', provider_name: 'claude' }] })
	);
	calls = [];
	stub_api(app);
});

const create_thread = (): Thread =>
	app.threads.add_thread(new Thread({ app, json: { model_name: 'test-model' } }));

describe('Thread.cancel_pending_turn', () => {
	test('cancels only the completion streaming into the given turn', async () => {
		const thread = create_thread();
		const earlier_turn = thread.add_assistant_turn('earlier');
		const sent = thread.send_message('hi');
		const assistant_turn = Array.from(thread.turns.by_id.values()).at(-1)!;

		assert.ok(!thread.cancel_pending_turn(earlier_turn));
		assert.ok(thread.pending);
		assert.ok(!calls[0]!.signal?.aborted);

		assert.ok(thread.cancel_pending_turn(assistant_turn));
		assert.ok(!thread.pending);
		assert.ok(assistant_turn.cancelled);
		assert.ok(calls[0]!.signal?.aborted);
		assert.strictEqual(await sent, assistant_turn);
	});

	test('a chunk for a pending turn without a text part cancels its completion', async () => {
		const handlers = create_frontend_action_handlers(app);
		const thread = create_thread();
		const sent = thread.send_message('hi');
		const assistant_turn = Array.from(thread.turns.by_id.values()).at(-1)!;
		app.diskfiles.add({ path: FILE_PATH, source_dir: SOURCE_DIR, content: 'file' });
		assistant_turn.part_ids = [app.parts.add({ type: 'diskfile', path: FILE_PATH }).id];

		const error_spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			void handlers.completion_progress!.receive!({
				data: {
					input: {
						chunk: { message: { role: 'assistant', content: 'x' } },
						_meta: { progressToken: assistant_turn.id }
					}
				}
			} as unknown as Parameters<
				NonNullable<NonNullable<FrontendActionHandlers['completion_progress']>['receive']>
			>[0]);
			assert.strictEqual(error_spy.mock.calls.length, 1);
		} finally {
			error_spy.mockRestore();
		}

		assert.ok(calls[0]!.signal?.aborted);
		assert.ok(assistant_turn.cancelled);
		assert.ok(!thread.pending);
		assert.strictEqual(app.diskfiles.get_by_path(FILE_PATH)?.content, 'file');
		await sent;
	});
});

describe('Thread.cancel_pending', () => {
	test('cancelling before the first chunk settles the assistant turn', async () => {
		const thread = create_thread();
		const sent = thread.send_message('hi');
		assert.ok(thread.pending);
		const assistant_turn = Array.from(thread.turns.by_id.values()).at(-1)!;
		assert.ok(assistant_turn.pending);

		thread.cancel_pending();

		assert.ok(!thread.pending);
		assert.ok(assistant_turn.cancelled);
		assert.ok(!assistant_turn.pending);
		assert.ok(calls[0]!.signal?.aborted);
		assert.strictEqual(await sent, assistant_turn);
	});

	test('the empty cancelled turn is excluded from the next request history', async () => {
		const thread = create_thread();
		const first = thread.send_message('hi');
		thread.cancel_pending();
		await first;

		const second = thread.send_message('again');
		assert.deepEqual(calls[1]!.completion_request.completion_messages, [
			{ role: 'user', content: 'hi' }
		]);
		calls[1]!.resolve();
		await second;
	});

	test('does not mark an already-settled turn cancelled', async () => {
		const thread = create_thread();
		const sent = thread.send_message('hi');
		const assistant_turn = Array.from(thread.turns.by_id.values()).at(-1)!;
		assistant_turn.error_message = 'boom';
		thread.cancel_pending();
		await sent;
		assert.ok(!assistant_turn.cancelled);
	});

	test('is a no-op when nothing is pending', () => {
		const thread = create_thread();
		thread.cancel_pending();
		assert.ok(!thread.pending);
	});
});

describe('Thread.send_message', () => {
	test('skips a send while another is in flight', async () => {
		const thread = create_thread();
		const first = thread.send_message('one');
		const second = await thread.send_message('two');

		assert.isNull(second);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(thread.turns.size, 2);

		calls[0]!.resolve();
		await first;
		assert.ok(!thread.pending);
	});
});

describe('a completion in flight when the socket drops', () => {
	test('settles its turn as errored through the real rpc path', async () => {
		// a real `api` over the ws transport, on a connection that's up when the
		// request goes out and then closes — fuz_app's client rejects in-flight
		// requests on close (they can't be correlated after a reconnect)
		const live = monkeypatch_zzz_for_tests(
			new Frontend({ models: [{ name: 'test-model', provider_name: 'claude' }] })
		);
		let reject_request: ((error: unknown) => void) | undefined;
		const connection: WebsocketRpcConnection = {
			connected: true,
			will_reconnect: false,
			request: () =>
				new Promise((_resolve, reject) => {
					reject_request = reject;
				}),
			send: () => true,
			add_message_handler: () => () => {},
			add_error_handler: () => () => {}
		};
		live.peer.transports.register_transport(
			new FrontendWebsocketTransport(connection, (data) => live.peer.receive(data))
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});

		const thread = live.threads.add_thread(
			new Thread({ app: live, json: { model_name: 'test-model' } })
		);
		const sent = thread.send_message('hi');
		const assistant_turn = Array.from(thread.turns.by_id.values()).at(-1)!;
		for (let i = 0; i < 10; i++) await Promise.resolve();
		assert.ok(reject_request, 'the request went out');
		assert.ok(assistant_turn.pending);

		reject_request(
			new ThrownJsonrpcError(
				JSONRPC_ERROR_CODES.service_unavailable,
				'[socket] connection closed (code 1006) (method=completion_create, id=1)'
			)
		);
		assert.strictEqual(await sent, assistant_turn);

		assert.ok(!thread.pending);
		assert.ok(assistant_turn.settled);
		assert.ok(!assistant_turn.pending);
		assert.include(assistant_turn.error_message, 'connection closed');
		live.dispose();
	});
});

describe('a file part still loading when sent', () => {
	/** A turn whose file part's content isn't loaded yet, its read held by the test. */
	const setup = () => {
		const read = create_deferred<unknown>();
		const read_paths: Array<string> = [];
		(app.api as unknown as Record<string, unknown>).diskfile_read = ({
			path
		}: {
			path: string;
		}) => {
			read_paths.push(path);
			return read.promise;
		};
		app.diskfiles.add_initial([
			{ id: FILE_PATH, source_dir: SOURCE_DIR, size: 9, ctime: 1, mtime: 1 }
		]);
		const thread = create_thread();
		const part = app.parts.add({ type: 'diskfile', path: FILE_PATH });
		const turn = new Turn({ app, json: { role: 'user', part_ids: [part.id] } });
		thread.add_turn(turn);
		return { thread, read, read_paths };
	};
	const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

	test('is awaited, and the request carries its content', async () => {
		const { thread, read, read_paths } = setup();
		const sent = thread.send_message('what does it say?');
		assert.ok(thread.pending, 'pending at once, as for any send');
		assert.strictEqual(thread.turns.size, 3);
		await flush();
		assert.strictEqual(calls.length, 0, 'waits for the content');
		assert.deepEqual(read_paths, [FILE_PATH]);

		read.resolve({
			ok: true,
			value: { contents: 'file text', unloaded_reason: null, size: 9, ctime: 1, mtime: 1 }
		});
		await flush();
		assert.strictEqual(calls.length, 1);
		assert.deepEqual(calls[0]!.completion_request.completion_messages, [
			{ role: 'user', content: 'file text' }
		]);
		const turns = Array.from(thread.turns.by_id.values());
		assert.strictEqual(turns.at(-1)!.request, calls[0]!.completion_request);
		assert.strictEqual(turns.at(-2)!.request, calls[0]!.completion_request);
		calls[0]!.resolve();
		await sent;
	});

	test('a failed read stops the send with an error, sending nothing', async () => {
		const { thread, read } = setup();
		const sent = thread.send_message('what does it say?');
		read.resolve({ ok: false, error: { code: -32603, message: 'connection lost' } });
		const assistant_turn = await sent;
		assert.ok(assistant_turn);
		assert.strictEqual(calls.length, 0);
		assert.include(assistant_turn.error_message, FILE_PATH);
		assert.include(assistant_turn.error_message, 'connection lost');
		assert.ok(!thread.pending);
	});

	test('a file already failed when sent stops the send too', async () => {
		const { thread, read } = setup();
		read.resolve({ ok: false, error: { code: -32603, message: 'connection lost' } });
		await flush();
		assert.strictEqual(app.diskfiles.get_by_path(FILE_PATH)?.content_error, 'connection lost');
		const assistant_turn = await thread.send_message('again');
		assert.strictEqual(calls.length, 0);
		assert.include(assistant_turn?.error_message, 'connection lost');
	});

	test('a failed read in a disabled turn does not stop the send', async () => {
		const { thread, read } = setup();
		read.resolve({ ok: false, error: { code: -32603, message: 'connection lost' } });
		await flush();
		for (const turn of thread.turns.by_id.values()) turn.enabled = false;
		const sent = thread.send_message('hi');
		await flush();
		assert.strictEqual(calls.length, 1);
		calls[0]!.resolve();
		const assistant_turn = await sent;
		assert.isUndefined(assistant_turn?.error_message);
	});

	test('a file too large to load is left out, as before, and the send goes', async () => {
		const { thread, read } = setup();
		const sent = thread.send_message('what does it say?');
		read.resolve({
			ok: true,
			value: { contents: null, unloaded_reason: 'too_large', size: 9, ctime: 1, mtime: 1 }
		});
		await flush();
		assert.strictEqual(calls.length, 1);
		assert.deepEqual(calls[0]!.completion_request.completion_messages, []);
		calls[0]!.resolve();
		const assistant_turn = await sent;
		assert.isUndefined(assistant_turn?.error_message);
	});

	test('cancelling while it loads sends nothing', async () => {
		const { thread, read } = setup();
		const sent = thread.send_message('hi');
		const assistant_turn = Array.from(thread.turns.by_id.values()).at(-1)!;
		thread.cancel_pending();
		read.resolve({
			ok: true,
			value: { contents: 'file text', unloaded_reason: null, size: 9, ctime: 1, mtime: 1 }
		});
		assert.strictEqual(await sent, assistant_turn);
		assert.ok(assistant_turn.cancelled);
		assert.strictEqual(calls.length, 0);
	});
});

describe('Thread.main_input', () => {
	test('defaults to empty and is independent per thread', () => {
		const a = create_thread();
		const b = create_thread();
		assert.strictEqual(a.main_input, '');
		a.main_input = 'draft for a';
		assert.strictEqual(b.main_input, '');
		assert.strictEqual(a.main_input_length, 'draft for a'.length);
		assert.ok(a.main_input_token_count > 0);
		assert.strictEqual(a.json.main_input, 'draft for a');
	});
});
