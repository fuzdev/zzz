// @vitest-environment jsdom

import {test, describe, assert} from 'vitest';

import {create_action_event, create_action_event_from_json} from '$lib/action_event.js';
import type {ActionEventEnvironment, ActionExecutor} from '$lib/action_event_types.js';
import type {ActionSpecUnion} from '@fuzdev/fuz_app/actions/action_spec.js';
import {
	ping_action_spec,
	filer_change_action_spec,
	toggle_main_menu_action_spec,
	completion_create_action_spec,
} from '$lib/action_specs.js';
import {create_uuid} from '$lib/zod_helpers.js';

// Mock environment for testing
class TestEnvironment implements ActionEventEnvironment {
	executor: ActionExecutor = 'frontend';
	peer: any = {}; // Mock peer, not used in tests
	handlers: Map<string, Map<string, (event: any) => any>> = new Map();
	specs: Map<string, ActionSpecUnion> = new Map();

	constructor(specs: Array<ActionSpecUnion> = []) {
		for (const spec of specs) {
			this.specs.set(spec.method, spec);
		}
	}

	lookup_action_handler(method: string, phase: string): ((event: any) => any) | undefined {
		return this.handlers.get(method)?.get(phase);
	}

	lookup_action_spec(method: string): ActionSpecUnion | undefined {
		return this.specs.get(method);
	}

	add_handler(method: string, phase: string, handler: (event: any) => any): void {
		if (!this.handlers.has(method)) {
			this.handlers.set(method, new Map());
		}
		this.handlers.get(method)!.set(phase, handler);
	}
}

describe('ActionEvent', () => {
	describe('creation', () => {
		test('creates event with initial state', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			assert.strictEqual(event.data.kind, 'request_response');
			assert.strictEqual(event.data.phase, 'send_request');
			assert.strictEqual(event.data.step, 'initial');
			assert.strictEqual(event.data.method, 'ping');
			assert.strictEqual(event.data.executor, 'frontend');
			assert.ok(event.data.input === undefined);
			assert.isNull(event.data.output);
			assert.isNull(event.data.error);
			assert.isNull(event.data.request);
			assert.isNull(event.data.response);
			assert.isNull(event.data.notification);
		});

		test('creates event with input data', () => {
			const env = new TestEnvironment([completion_create_action_spec]);
			const input = {
				completion_request: {
					created: '2024-01-01T00:00:00Z',
					request_id: create_uuid(),
					provider_name: 'claude',
					model: 'claude-3-opus',
					prompt: 'test prompt',
				},
			};

			const event = create_action_event(env, completion_create_action_spec, input);

			assert.deepEqual(event.data.input, input);
		});

		test('creates event with specified initial phase', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined, 'receive_request');

			assert.strictEqual(event.data.phase, 'receive_request');
		});

		test('throws for invalid executor/initiator combination', () => {
			const env = new TestEnvironment([filer_change_action_spec]);
			env.executor = 'frontend';

			// filer_change has initiator: 'backend', so frontend can't initiate send
			assert.throws(
				() => create_action_event(env, filer_change_action_spec, {}),
				/executor 'frontend' cannot initiate action 'filer_change'/,
			);
		});
	});

	describe('parse()', () => {
		test('parses valid input successfully', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			event.parse();

			assert.strictEqual(event.data.step, 'parsed');
			// ping has void input, so it should remain undefined
			assert.ok(event.data.input === undefined);
		});

		test('parses complex input with validation', () => {
			const env = new TestEnvironment([completion_create_action_spec]);
			const input = {
				completion_request: {
					created: '2024-01-01T00:00:00Z',
					provider_name: 'claude',
					model: 'claude-3-opus',
					prompt: 'test prompt',
				},
				_meta: {progressToken: create_uuid()},
			};

			const event = create_action_event(env, completion_create_action_spec, input);
			event.parse();

			assert.strictEqual(event.data.step, 'parsed');
			assert.deepEqual(event.data.input, input);
		});

		test('fails on invalid input', () => {
			const env = new TestEnvironment([completion_create_action_spec]);
			const invalid_input = {
				completion_request: {
					// Missing required fields
					prompt: 'test',
				},
			};

			const event = create_action_event(env, completion_create_action_spec, invalid_input);
			event.parse();

			assert.strictEqual(event.data.step, 'failed');
			assert.isDefined(event.data.error);
			assert.strictEqual(event.data.error?.code, -32602);
			assert.include(event.data.error?.message, 'failed to parse input');
		});

		test('throws when not in initial step', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			event.parse(); // First parse succeeds

			// Second parse should throw
			assert.throws(() => event.parse(), /cannot parse from step 'parsed' - must be 'initial'/);
		});
	});

	describe('handle_async()', () => {
		test('executes handler successfully', async () => {
			const env = new TestEnvironment([ping_action_spec]);

			env.add_handler('ping', 'send_request', async () => {
				// Handler logic
			});

			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();

			await event.handle_async();

			assert.strictEqual(event.data.step, 'handled');
			// send_request doesn't produce output
			assert.isNull(event.data.output);
			// But it should have created a request
			assert.isDefined(event.data.request);
			assert.strictEqual(event.data.request?.method, 'ping');
		});

		test('handles missing handler gracefully', async () => {
			const env = new TestEnvironment([ping_action_spec]);
			// No handler registered

			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();

			await event.handle_async();

			assert.strictEqual(event.data.step, 'handled');
		});

		test('captures handler errors', async () => {
			const env = new TestEnvironment([ping_action_spec]);

			env.add_handler('ping', 'send_request', () => {
				throw new Error('handler error');
			});

			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();

			await event.handle_async();

			// Handler errors transition to error phase, not directly to failed
			assert.strictEqual(event.data.step, 'parsed');
			assert.strictEqual(event.data.phase, 'send_error');
			assert.isDefined(event.data.error);
			assert.strictEqual(event.data.error?.code, -32603);
			assert.include(event.data.error?.message, 'unknown error');
		});

		test('send_error handler can handle errors gracefully', async () => {
			const env = new TestEnvironment([ping_action_spec]);
			let error_logged = false;

			// Primary handler throws
			env.add_handler('ping', 'send_request', () => {
				throw new Error('primary handler error');
			});

			// Error handler logs and completes successfully
			env.add_handler('ping', 'send_error', (event) => {
				error_logged = true;
				assert.isDefined(event.data.error);
				assert.include(event.data.error?.message, 'primary handler error');
				// Error handler completes without throwing
			});

			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();
			await event.handle_async();

			// First error transitions to send_error
			assert.strictEqual(event.data.phase, 'send_error');
			assert.strictEqual(event.data.step, 'parsed');

			// Handle error phase
			await event.handle_async();

			// Error handler completed successfully
			assert.ok(error_logged);
			assert.strictEqual(event.data.step, 'failed');
			assert.strictEqual(event.data.phase, 'send_error');
			assert.ok(event.is_complete());
		});

		test('receive_error handler can handle errors gracefully', async () => {
			const env = new TestEnvironment([ping_action_spec]);
			let error_handled = false;

			// Error handler can inspect and handle the error
			env.add_handler('ping', 'receive_error', (event) => {
				error_handled = true;
				assert.isDefined(event.data.error);
				assert.strictEqual(event.data.error?.code, -32603);
				// Could implement retry logic, fallback, logging, etc.
			});

			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();
			// Mock handling and transition
			event.data.step = 'handled';
			event.data.request = {
				jsonrpc: '2.0',
				id: create_uuid(),
				method: 'ping',
			};

			event.transition('receive_response');

			// Simulate error response
			const errorResponse = {
				jsonrpc: '2.0',
				id: event.data.request.id,
				error: {
					code: -32603,
					message: 'Server error',
				},
			} as const;

			event.set_response(errorResponse);
			event.parse();

			// Should be in receive_error phase
			assert.strictEqual(event.data.phase, 'receive_error');
			assert.strictEqual(event.data.step, 'parsed');

			// Handle error phase
			await event.handle_async();

			// Error handler completed successfully
			assert.ok(error_handled);
			assert.strictEqual(event.data.step, 'handled');
			assert.ok(event.is_complete());
		});

		test('validates output for phases that expect it', async () => {
			const env = new TestEnvironment([ping_action_spec]);
			env.executor = 'backend';

			env.add_handler('ping', 'receive_request', () => {
				return Promise.resolve({ping_id: create_uuid()});
			});

			const event = create_action_event(env, ping_action_spec, undefined, 'receive_request');
			event.parse();

			await event.handle_async();

			assert.strictEqual(event.data.step, 'handled');
			assert.isDefined(event.data.output);
			assert.ok(Object.hasOwn(event.data.output as any, 'ping_id'));
		});

		test('throws when not in parsed step', async () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			// Not parsed yet
			try {
				await event.handle_async();
				assert.fail('expected handle_async to throw');
			} catch (e: any) {
				assert.include(e.message, "cannot handle from step 'initial' - must be 'parsed'");
			}
		});

		test('is no-op when already failed', async () => {
			const env = new TestEnvironment([completion_create_action_spec]);
			const invalid_input = {
				completion_request: {
					// Missing required fields
					prompt: 'test',
				},
			};

			const event = create_action_event(env, completion_create_action_spec, invalid_input);
			event.parse();

			// Should be failed after parsing invalid input
			assert.strictEqual(event.data.step, 'failed');
			const original_error = event.data.error;

			// handle_async should be no-op
			await event.handle_async();

			// State should remain unchanged
			assert.strictEqual(event.data.step, 'failed');
			assert.strictEqual(event.data.error, original_error);
		});
	});

	describe('handle_sync()', () => {
		test('executes synchronous local_call', () => {
			const env = new TestEnvironment([toggle_main_menu_action_spec]);
			const output = {show: true};

			env.add_handler('toggle_main_menu', 'execute', () => output);

			const event = create_action_event(env, toggle_main_menu_action_spec, {show: true});
			event.parse();

			event.handle_sync();

			assert.strictEqual(event.data.step, 'handled');
			assert.deepEqual(event.data.output, output);
		});

		test('throws for async actions', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();

			assert.throws(
				() => event.handle_sync(),
				/handle_sync can only be used with synchronous local_call actions/,
			);
		});

		test('is no-op when already failed', () => {
			const env = new TestEnvironment([toggle_main_menu_action_spec]);

			// Force a failure by providing invalid input - show must be boolean
			const event = create_action_event(env, toggle_main_menu_action_spec, {show: 'not-a-boolean'});
			event.parse();

			// Should be failed after parsing invalid input
			assert.strictEqual(event.data.step, 'failed');
			const original_error = event.data.error;

			// handle_sync should be no-op
			event.handle_sync();

			// State should remain unchanged
			assert.strictEqual(event.data.step, 'failed');
			assert.strictEqual(event.data.error, original_error);
		});
	});

	describe('transition()', () => {
		test('transitions between valid phases', async () => {
			const env = new TestEnvironment([ping_action_spec]);

			// Start in send_request
			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();
			await event.handle_async();

			assert.strictEqual(event.data.phase, 'send_request');
			assert.strictEqual(event.data.step, 'handled');

			// Transition to receive_response
			event.transition('receive_response');

			assert.strictEqual(event.data.phase, 'receive_response');
			assert.strictEqual(event.data.step, 'initial');
			// Request should be preserved
			assert.isDefined(event.data.request);
		});

		test('throws for invalid phase transition', async () => {
			const env = new TestEnvironment([ping_action_spec]);

			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();
			await event.handle_async();

			// Can't go from send_request to send_response
			assert.throws(
				() => event.transition('send_response'),
				/Invalid phase transition from 'send_request' to 'send_response'/,
			);
		});

		test('throws when not in handled step', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			// Still in initial step
			assert.throws(
				() => event.transition('receive_response'),
				/cannot transition from step 'initial' - must be 'handled'/,
			);
		});

		test('carries data forward in transitions', async () => {
			const env = new TestEnvironment([ping_action_spec]);
			env.executor = 'backend';

			const event = create_action_event(env, ping_action_spec, undefined, 'receive_request');
			const request = {
				jsonrpc: '2.0',
				id: create_uuid(),
				method: 'ping',
			} as const;
			event.set_request(request);

			env.add_handler('ping', 'receive_request', () => ({ping_id: request.id}));

			event.parse();
			await event.handle_async();

			// Transition to send_response
			event.transition('send_response');

			assert.strictEqual(event.data.phase, 'send_response');
			assert.deepEqual(event.data.request, request);
			assert.deepEqual(event.data.output, {ping_id: request.id});
			assert.isDefined(event.data.response);
			assert.ok(Object.hasOwn(event.data.response as any, 'result'));
		});

		test('is no-op when already failed', async () => {
			const env = new TestEnvironment([ping_action_spec]);

			// First handler throws, transitions to send_error
			env.add_handler('ping', 'send_request', () => {
				throw new Error('handler error to force error phase');
			});

			// Error handler also throws, transitions to failed
			env.add_handler('ping', 'send_error', () => {
				throw new Error('error handler also throws');
			});

			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();
			await event.handle_async();

			// First error transitions to send_error
			assert.strictEqual(event.data.step, 'parsed');
			assert.strictEqual(event.data.phase, 'send_error');

			// Handle error phase - this will throw and transition to failed
			await event.handle_async();

			// Now should be failed after error handler error
			assert.strictEqual(event.data.step, 'failed');
			const original_error = event.data.error;
			const original_phase = event.data.phase;

			// transition should be no-op when failed
			event.transition('receive_response');

			// State should remain unchanged
			assert.strictEqual(event.data.step, 'failed');
			assert.strictEqual(event.data.phase, original_phase);
			assert.strictEqual(event.data.error, original_error);
		});
	});

	describe('protocol setters', () => {
		test('set_request() sets request data', () => {
			const env = new TestEnvironment([ping_action_spec]);
			env.executor = 'backend';

			const event = create_action_event(env, ping_action_spec, undefined, 'receive_request');
			const request = {
				jsonrpc: '2.0',
				id: create_uuid(),
				method: 'ping',
			} as const;

			event.set_request(request);

			assert.deepEqual(event.data.request, request);
		});

		test('set_response() sets response and extracts output', () => {
			const env = new TestEnvironment([ping_action_spec]);

			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();
			// Need to handle and transition first
			event.handle_sync = () => {
				// Mock sync handling
			};
			event.data.step = 'handled';
			event.data.request = {
				jsonrpc: '2.0',
				id: create_uuid(),
				method: 'ping',
			};

			event.transition('receive_response');

			const response = {
				jsonrpc: '2.0',
				id: event.data.request.id,
				result: {ping_id: create_uuid()},
			} as const;

			event.set_response(response);

			assert.deepEqual(event.data.response, response);
			assert.deepEqual(event.data.output, response.result);
		});

		test('error response transitions to receive_error phase on parse', () => {
			const env = new TestEnvironment([ping_action_spec]);

			const event = create_action_event(env, ping_action_spec, undefined);
			event.parse();
			// Need to handle and transition first
			event.handle_sync = () => {
				// Mock sync handling
			};
			event.data.step = 'handled';
			event.data.request = {
				jsonrpc: '2.0',
				id: create_uuid(),
				method: 'ping',
			};

			event.transition('receive_response');

			const errorResponse = {
				jsonrpc: '2.0',
				id: event.data.request.id,
				error: {
					code: -32603,
					message: 'Internal error',
					data: {details: 'Test error'},
				},
			} as const;

			event.set_response(errorResponse);

			// Parse should detect the error and transition to receive_error phase
			event.parse();

			assert.strictEqual(event.data.step, 'parsed');
			assert.strictEqual(event.data.phase, 'receive_error');
			assert.deepEqual(event.data.error, errorResponse.error);
			assert.deepEqual(event.data.response, errorResponse);
			assert.isNull(event.data.output);
		});

		test('set_notification() sets notification data', () => {
			const env = new TestEnvironment([filer_change_action_spec]);
			env.executor = 'frontend';

			const event = create_action_event(env, filer_change_action_spec, {}, 'receive');
			const notification = {
				jsonrpc: '2.0',
				method: 'filer_change',
				params: {
					change: {type: 'add', path: '/test.txt'},
					disknode: {} as any,
				},
			} as const;

			event.set_notification(notification);

			assert.deepEqual(event.data.notification, notification);
		});

		test('setters throw for wrong phase/kind', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			assert.throws(
				() => event.set_request({} as any),
				/can only set request in receive_request phase/,
			);

			assert.throws(
				() => event.set_notification({} as any),
				/can only set notification in receive phase/,
			);
		});
	});

	describe('is_complete()', () => {
		test('returns true for terminal phases', async () => {
			const env = new TestEnvironment([ping_action_spec]);

			const event = create_action_event(env, ping_action_spec, undefined);

			// Not complete in initial state
			assert.ok(!event.is_complete());

			// Handle through to receive_response
			event.parse();
			await event.handle_async();
			event.transition('receive_response');
			event.set_response({
				jsonrpc: '2.0',
				id: create_uuid(),
				result: {ping_id: create_uuid()},
			});
			event.parse();
			await event.handle_async();

			// receive_response is terminal for request_response
			assert.ok(event.is_complete());
		});

		test('returns true for failed state', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, {invalid: 'input'});

			event.parse(); // Will fail due to invalid input

			assert.strictEqual(event.data.step, 'failed');
			assert.ok(event.is_complete());
		});

		test('returns false for non-terminal phases', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			event.parse();

			// Parsed but not handled
			assert.ok(!event.is_complete());
		});
	});

	describe('observe()', () => {
		test('notifies listeners of state changes', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			const changes: Array<{old_step: string; new_step: string}> = [];

			event.observe((new_data, old_data) => {
				changes.push({
					old_step: old_data.step,
					new_step: new_data.step,
				});
			});

			event.parse();

			assert.strictEqual(changes.length, 1);
			assert.deepEqual(changes[0], {
				old_step: 'initial',
				new_step: 'parsed',
			});
		});

		test('cleanup function removes listener', async () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			let call_count = 0;
			const cleanup = event.observe(() => {
				call_count++;
			});

			event.parse();
			assert.strictEqual(call_count, 1);

			cleanup();

			await event.handle_async();
			assert.strictEqual(call_count, 1); // No additional calls
		});

		test('multiple listeners work independently', () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			const listener1_calls: Array<string> = [];
			const listener2_calls: Array<string> = [];

			event.observe((new_data) => {
				listener1_calls.push(new_data.step);
			});

			event.observe((new_data) => {
				listener2_calls.push(new_data.step);
			});

			event.parse();

			assert.deepEqual(listener1_calls, ['parsed']);
			assert.deepEqual(listener2_calls, ['parsed']);
		});
	});

	describe('toJSON() and from_json()', () => {
		test('serializes and deserializes event state', async () => {
			const env = new TestEnvironment([ping_action_spec]);
			const event = create_action_event(env, ping_action_spec, undefined);

			event.parse();
			await event.handle_async();

			const json = event.toJSON();

			assert.strictEqual(json.kind, 'request_response');
			assert.strictEqual(json.phase, 'send_request');
			assert.strictEqual(json.step, 'handled');
			assert.isDefined(json.request);

			// Reconstruct from JSON
			const restored = create_action_event_from_json(json, env);

			assert.deepEqual(restored.data, event.data);
		});

		test('throws when spec not found for deserialization', () => {
			const env = new TestEnvironment(); // No specs registered

			const json = {
				kind: 'request_response',
				phase: 'send_request',
				step: 'initial',
				method: 'unknown_method',
				executor: 'frontend',
				input: undefined,
				output: null,
				error: null,
				request: null,
				response: null,
				notification: null,
			};

			assert.throws(
				() => create_action_event_from_json(json as any, env),
				/no spec found for method 'unknown_method'/,
			);
		});
	});

	describe('environment helpers', () => {
		test('app getter works for frontend environment', () => {
			const env = new TestEnvironment([ping_action_spec]);
			env.executor = 'frontend';

			const event = create_action_event(env, ping_action_spec, undefined);

			assert.strictEqual(event.app, env);
		});

		test('backend getter works for backend environment', () => {
			const env = new TestEnvironment([ping_action_spec]);
			env.executor = 'backend';

			const event = create_action_event(env, ping_action_spec, undefined);

			assert.strictEqual(event.backend, env);
		});

		test('app getter throws for backend environment', () => {
			const env = new TestEnvironment([ping_action_spec]);
			env.executor = 'backend';

			const event = create_action_event(env, ping_action_spec, undefined);

			assert.throws(
				() => event.app,
				/action_event\.app.*can only be accessed in frontend environments/,
			);
		});

		test('backend getter throws for frontend environment', () => {
			const env = new TestEnvironment([ping_action_spec]);
			env.executor = 'frontend';

			const event = create_action_event(env, ping_action_spec, undefined);

			assert.throws(
				() => event.backend,
				/action_event\.backend.*can only be accessed in backend environments/,
			);
		});
	});

	describe('different action kinds', () => {
		test('remote_notification fails parsing with invalid input', async () => {
			const env = new TestEnvironment([filer_change_action_spec]);
			env.executor = 'backend';

			const invalid_input = {
				change: {type: 'add', path: '/test.txt'},
				disknode: {} as any, // Missing required fields
			};

			const event = create_action_event(env, filer_change_action_spec, invalid_input);
			event.parse();

			// Should fail during parsing
			assert.strictEqual(event.data.step, 'failed');
			assert.isDefined(event.data.error);
			assert.strictEqual(event.data.error?.code, -32602);
			assert.include(event.data.error?.message, 'failed to parse input');

			// Should be a no-op when handling after parse failure
			await event.handle_async();
			assert.strictEqual(event.data.step, 'failed'); // Still failed, no change
		});

		test('remote_notification creates notification in send phase', async () => {
			const env = new TestEnvironment([filer_change_action_spec]);
			env.executor = 'backend';

			const input = {
				change: {type: 'add', path: '/test.txt'},
				disknode: {
					id: '/test.txt',
					source_dir: '/',
					contents: 'test content',
					ctime: Date.now(),
					mtime: Date.now(),
					dependents: [],
					dependencies: [],
				},
			};

			const event = create_action_event(env, filer_change_action_spec, input);
			event.parse();
			await event.handle_async();

			assert.isDefined(event.data.notification);
			assert.strictEqual(event.data.notification?.method, 'filer_change');
			assert.deepEqual(event.data.notification?.params, input);
		});

		test('local_call completes in single phase', () => {
			const env = new TestEnvironment([toggle_main_menu_action_spec]);

			env.add_handler('toggle_main_menu', 'execute', () => ({show: false}));

			const event = create_action_event(env, toggle_main_menu_action_spec, {show: true});
			event.parse();
			event.handle_sync();

			assert.strictEqual(event.data.phase, 'execute');
			assert.strictEqual(event.data.step, 'handled');
			assert.deepEqual(event.data.output, {show: false});
			assert.ok(event.is_complete());
		});
	});
});
