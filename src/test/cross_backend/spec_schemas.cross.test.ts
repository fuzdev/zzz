/**
 * Cross-backend wire-shape conformance for zzz's own action specs: the
 * `zzz_server` responses and backend-initiated notifications exercised here
 * parse against their TS `spec.output` / `spec.input`.
 *
 * The frontend validates both at runtime (a response or notification that
 * doesn't match its strict schema is rejected), so drift between the Rust
 * handlers and `action_specs.ts` breaks the app — this pins the parity.
 * Covers the session, provider-status, workspace, filesystem, and terminal
 * actions; `completion_create` / `completion_progress` need a live provider
 * and aren't exercised. fuz_app's standard specs are covered by its own
 * conformance suite.
 *
 * Every `z.void()` method is also sent over a real WebSocket with `params`
 * both omitted and `{}` — the shape fuz_app's socket client sends for a
 * parameterless request — since HTTP callers omit `params` and so can't
 * catch a backend that refuses `{}`.
 *
 * @module
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, test, inject, assert, afterEach, afterAll, beforeAll, vi } from 'vitest';
import type { z } from 'zod';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import { rpc_call } from '@fuzdev/fuz_app/testing/rpc_helpers.ts';
import { create_ws_transport } from '@fuzdev/fuz_app/testing/transports/ws_transport.ts';
import type {
	RemoteNotificationActionSpec,
	RequestResponseActionSpec
} from '@fuzdev/fuz_app/actions/action_spec.ts';
import { all_account_action_specs } from '@fuzdev/fuz_app/auth/account_action_specs.ts';
import { is_void_schema } from '@fuzdev/fuz_app/http/schema_helpers.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';

import {
	directory_create_action_spec,
	diskfile_create_action_spec,
	diskfile_delete_action_spec,
	diskfile_update_action_spec,
	filer_change_action_spec,
	heartbeat_action_spec,
	ping_action_spec,
	provider_load_status_action_spec,
	session_load_action_spec,
	terminal_close_action_spec,
	terminal_create_action_spec,
	terminal_data_action_spec,
	terminal_data_send_action_spec,
	terminal_exited_action_spec,
	terminal_resize_action_spec,
	workspace_changed_action_spec,
	workspace_close_action_spec,
	workspace_list_action_spec,
	workspace_open_action_spec,
	all_action_specs
} from '$lib/action_specs.ts';
import type { FrontendActionsApi } from '$lib/action_metatypes.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle);

type CrossFixture = Awaited<ReturnType<typeof setup_test>>;
type WsClient = Awaited<ReturnType<typeof create_ws_transport>>;

/** Assert `value` parses against `schema`, reporting the issues on failure. */
const assert_parses = (schema: z.ZodType, value: unknown, label: string): void => {
	const parsed = schema.safeParse(value);
	assert.ok(
		parsed.success,
		`${label} does not match its TS schema: ${JSON.stringify(parsed.error?.issues)} — got ${JSON.stringify(value)}`
	);
};

/** Call `spec` over HTTP RPC and assert the result matches `spec.output`. */
const call_and_check = async (
	fixture: CrossFixture,
	spec: RequestResponseActionSpec,
	params?: Record<string, unknown>
): Promise<unknown> => {
	const res = await rpc_call({
		app: fixture.transport,
		path: handle.config.rpc_path,
		method: spec.method,
		params,
		headers: fixture.create_session_headers()
	});
	assert.ok(res.ok, `${spec.method} failed: ${JSON.stringify(res)}`);
	assert_parses(spec.output, res.result, `${spec.method} result`);
	return res.result;
};

/** Call `spec` over the WebSocket and assert the result matches `spec.output`. */
const ws_call_and_check = async (
	ws: WsClient,
	spec: RequestResponseActionSpec,
	params: Record<string, unknown>
): Promise<unknown> => {
	const result = await ws.request(randomUUID(), spec.method, params);
	assert_parses(spec.output, result, `${spec.method} result (ws)`);
	return result;
};

/** Wait for a `spec` notification matching `where` and assert its params match `spec.input`. */
const wait_for_checked_notification = async (
	ws: WsClient,
	spec: RemoteNotificationActionSpec,
	where: (params: Record<string, unknown>) => boolean = () => true
): Promise<void> => {
	const msg = await ws.wait_for<Record<string, unknown>>((m) => {
		const message = m as Record<string, unknown> | null;
		return message?.method === spec.method && where(message.params as Record<string, unknown>);
	}, 10_000);
	assert_parses(spec.input, msg.params, `${spec.method} params`);
};

/**
 * Every `z.void()` request the frontend can send: zzz's own, plus the
 * read-only account specs the spine serves on the same endpoints.
 */
const void_specs: Array<RequestResponseActionSpec> = [
	...all_action_specs.filter(
		(spec): spec is RequestResponseActionSpec =>
			spec.kind === 'request_response' && spec.initiator !== 'backend' && is_void_schema(spec.input)
	),
	...all_account_action_specs.filter((spec) => is_void_schema(spec.input) && !spec.side_effects)
];

const open_ws = (fixture: CrossFixture): Promise<WsClient> =>
	create_ws_transport({
		base_url: handle.config.base_url,
		ws_path: handle.config.ws_path,
		cookies: fixture.transport.cookies()
	});

describe('zzz spec schemas cross-backend', () => {
	test('session and provider responses match their output schemas', async () => {
		const fixture = await setup_test();
		await call_and_check(fixture, ping_action_spec);
		await call_and_check(fixture, session_load_action_spec);
		await call_and_check(fixture, provider_load_status_action_spec, { provider_name: 'gemini' });
	});

	test('void-input methods answer with params omitted or {}, over WS and HTTP', async () => {
		assert.includeMembers(
			void_specs.map((spec) => spec.method),
			[
				'ping',
				'session_load',
				'workspace_list',
				'account_verify',
				'account_session_list',
				'account_token_list'
			],
			'the void-spec enumeration lost a method'
		);
		const fixture = await setup_test();
		const ws = await open_ws(fixture);
		try {
			for (const spec of void_specs) {
				for (const params of [undefined, {}]) {
					const label = `${spec.method} params=${params ? '{}' : '<omitted>'}`;
					const result = await ws.request(randomUUID(), spec.method, params).catch((e: unknown) => {
						assert.fail(`${label} over ws: ${e instanceof Error ? e.message : String(e)}`);
					});
					assert_parses(spec.output, result, `${label} result (ws)`);
					if (spec.method === heartbeat_action_spec.method) {
						// served over the WebSocket only — over HTTP it's an unknown method
						const res = await rpc_call({
							app: fixture.transport,
							path: handle.config.rpc_path,
							method: spec.method,
							params,
							headers: fixture.create_session_headers()
						});
						assert.ok(
							!res.ok && res.error.code === JSONRPC_ERROR_CODES.method_not_found,
							`${label} over http: ${JSON.stringify(res)}`
						);
					} else {
						await call_and_check(fixture, spec, params);
					}
				}
				// a declared key is still refused
				const refused = await ws.request(randomUUID(), spec.method, { nope: 1 }).then(
					() => null,
					(e: unknown) => (e instanceof Error ? e.message : String(e))
				);
				assert.include(refused, '[-32602]', `${spec.method} must refuse a declared key`);
			}
		} finally {
			await ws.close();
		}
	});

	test('workspace and filesystem responses and notifications match their schemas', async () => {
		const fixture = await setup_test();
		const ws = await open_ws(fixture);
		const dir = join(tmpdir(), `zzz_cross_schemas_${randomUUID()}`);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'seed.txt'), 'seed', 'utf-8');
		try {
			await ws.request('_warmup', 'ping', undefined);

			await call_and_check(fixture, workspace_open_action_spec, { path: dir });
			await wait_for_checked_notification(ws, workspace_changed_action_spec);
			await call_and_check(fixture, workspace_list_action_spec);
			await call_and_check(fixture, session_load_action_spec);

			const file_path = join(dir, 'written.txt');
			await call_and_check(fixture, diskfile_update_action_spec, {
				path: file_path,
				content: 'hello'
			});
			await wait_for_checked_notification(
				ws,
				filer_change_action_spec,
				(p) => (p.change as Record<string, unknown> | undefined)?.path === file_path
			);
			await call_and_check(fixture, directory_create_action_spec, { path: join(dir, 'sub') });
			await call_and_check(fixture, diskfile_delete_action_spec, { path: file_path });
			await call_and_check(fixture, diskfile_create_action_spec, {
				path: join(dir, 'created.txt'),
				content: 'new'
			});

			await call_and_check(fixture, workspace_close_action_spec, { path: dir });
		} finally {
			await ws.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('terminal responses and notifications match their schemas', async () => {
		const fixture = await setup_test();
		const ws = await open_ws(fixture);
		try {
			await ws.request('_warmup', 'ping', undefined);

			// a short-lived terminal for data + exit
			const echo = (await ws_call_and_check(ws, terminal_create_action_spec, {
				command: 'echo',
				args: ['schemas']
			})) as { terminal_id: string };
			await wait_for_checked_notification(
				ws,
				terminal_data_action_spec,
				(p) => p.terminal_id === echo.terminal_id
			);
			await wait_for_checked_notification(
				ws,
				terminal_exited_action_spec,
				(p) => p.terminal_id === echo.terminal_id
			);

			// a long-lived terminal for input, resize, and close
			const cat = (await ws_call_and_check(ws, terminal_create_action_spec, {
				command: 'cat'
			})) as { terminal_id: string };
			await ws_call_and_check(ws, terminal_data_send_action_spec, {
				terminal_id: cat.terminal_id,
				data: 'x'
			});
			await ws_call_and_check(ws, terminal_resize_action_spec, {
				terminal_id: cat.terminal_id,
				cols: 100,
				rows: 30
			});
			// the session snapshot lists the live terminal
			const session = (await call_and_check(fixture, session_load_action_spec)) as z.infer<
				typeof session_load_action_spec.output
			>;
			assert.include(session.data.terminal_ids, cat.terminal_id);
			await ws_call_and_check(ws, terminal_close_action_spec, { terminal_id: cat.terminal_id });
		} finally {
			await ws.close();
		}
	});

	describe('through the frontend ActionEvent + WebSocket transport path', () => {
		// `FrontendWebsocketClient.connect` is browser-only, so the client stack
		// is imported fresh under a scoped `esm-env` mock. The cross projects
		// share one module registry (`isolate: false`), so the mock is scoped to
		// this block and the registry reset on both sides — later files get the
		// real `esm-env`.
		let client_modules: {
			FrontendWebsocketClient: typeof import('@fuzdev/fuz_app/actions/socket.svelte.ts').FrontendWebsocketClient;
			FrontendWebsocketTransport: typeof import('@fuzdev/fuz_app/actions/transports_ws.ts').FrontendWebsocketTransport;
			create_frontend_rpc_client: typeof import('@fuzdev/fuz_app/actions/frontend_rpc_client.ts').create_frontend_rpc_client;
		};
		beforeAll(async () => {
			vi.resetModules();
			vi.doMock('esm-env', () => ({ BROWSER: true, DEV: true, NODE: true }));
			const [socket, transports_ws, frontend_rpc_client] = await Promise.all([
				import('@fuzdev/fuz_app/actions/socket.svelte.ts'),
				import('@fuzdev/fuz_app/actions/transports_ws.ts'),
				import('@fuzdev/fuz_app/actions/frontend_rpc_client.ts')
			]);
			client_modules = {
				FrontendWebsocketClient: socket.FrontendWebsocketClient,
				FrontendWebsocketTransport: transports_ws.FrontendWebsocketTransport,
				create_frontend_rpc_client: frontend_rpc_client.create_frontend_rpc_client
			};
		});
		afterAll(() => {
			vi.doUnmock('esm-env');
			vi.resetModules();
		});

		const original_websocket = globalThis.WebSocket;
		afterEach(() => {
			globalThis.WebSocket = original_websocket;
		});

		/**
		 * Open the published client stack against the backend: a
		 * `FrontendWebsocketClient` behind `FrontendWebsocketTransport`, driven
		 * by `create_frontend_rpc_client` — the frontend's own request path.
		 */
		const open_client = async (fixture: CrossFixture) => {
			// a browser sends the session cookie + Origin on the upgrade; Node's
			// WebSocket (undici) takes them as a non-standard `headers` init option
			const init = {
				headers: {
					Cookie: fixture.transport.cookies().join('; '),
					Origin: handle.config.base_url
				}
			};
			globalThis.WebSocket = class extends original_websocket {
				constructor(url: string | URL) {
					super(url, init as unknown as Array<string>);
				}
			};

			const ws_url = handle.config.base_url.replace(/^http/, 'ws') + handle.config.ws_path;
			const { FrontendWebsocketClient, FrontendWebsocketTransport, create_frontend_rpc_client } =
				client_modules;
			const client = new FrontendWebsocketClient(ws_url, { reconnect: false });
			const { api_result } = create_frontend_rpc_client<FrontendActionsApi>({
				specs: all_action_specs,
				transports: [new FrontendWebsocketTransport(client, async () => null)]
			});
			client.connect();
			// the transport reports ready only once the socket is open
			for (let i = 0; i < 40 && !client.connected; i++) {
				await new Promise((r) => setTimeout(r, 50));
			}
			assert.ok(
				client.connected,
				`socket did not open (status ${client.status}, close ${client.last_close_code})`
			);
			return { client, api_result };
		};

		test('void-input actions resolve ok', async () => {
			// the socket client sends a parameterless request's `params` as the
			// client version dictates — omitted, or `{}` — and both must be the call
			const fixture = await setup_test();
			const { client, api_result } = await open_client(fixture);
			try {
				const ping = await api_result.ping();
				assert.ok(ping.ok, `ping over ws: ${JSON.stringify(ping)}`);
				const session = await api_result.session_load();
				assert.ok(session.ok, `session_load over ws: ${JSON.stringify(session)}`);
				const list = await api_result.workspace_list();
				assert.ok(list.ok, `workspace_list over ws: ${JSON.stringify(list)}`);
			} finally {
				client.disconnect();
			}
		});

		test('null-output actions resolve ok', async () => {
			const fixture = await setup_test();
			const { client, api_result } = await open_client(fixture);
			const dir = join(tmpdir(), `zzz_cross_schemas_ws_${randomUUID()}`);
			await mkdir(dir, { recursive: true });
			try {
				await call_and_check(fixture, workspace_open_action_spec, { path: dir });

				const file_path = join(dir, 'via_ws.txt');
				const update = await api_result.diskfile_update({
					path: file_path as never,
					content: 'over ws'
				});
				assert.ok(update.ok, `diskfile_update over ws: ${JSON.stringify(update)}`);
				assert.isNull(update.value);
				assert.strictEqual(await readFile(file_path, 'utf-8'), 'over ws');

				const close = await api_result.workspace_close({ path: `${dir}/` as never });
				assert.ok(close.ok, `workspace_close over ws: ${JSON.stringify(close)}`);
			} finally {
				client.disconnect();
				await rm(dir, { recursive: true, force: true });
			}
		});
	});
});
