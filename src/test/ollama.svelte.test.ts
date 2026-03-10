// @vitest-environment jsdom

import {test, describe, assert} from 'vitest';

import {Ollama} from '$lib/ollama.svelte.js';
import {Frontend} from '$lib/frontend.svelte.js';
import config from '$lib/config.js';
import {OLLAMA_URL} from '$lib/ollama_helpers.js';
import {create_action_event} from '$lib/action_event.js';

describe('Ollama', () => {
	const create_test_app = () => {
		const {providers, models} = config();
		return new Frontend({
			providers,
			models,
		});
	};

	test('should initialize with default values', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		assert.strictEqual(ollama.host, OLLAMA_URL);
		assert.strictEqual(ollama.list_status, 'initial');
		assert.ok(!ollama.available);
		assert.typeOf(ollama.models.length, 'number');
	});

	test('should track pending and completed actions', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		assert.strictEqual(ollama.pending_actions.length, 0);
		assert.strictEqual(ollama.completed_actions.length, 0);

		// Add a pending action
		app.actions.add_from_json({
			method: 'ollama_pull',
			action_event_data: {
				kind: 'local_call',
				phase: 'execute',
				step: 'handling',
				method: 'ollama_pull',
				executor: 'frontend',
				input: {model: 'test_model_1'},
				output: null,
				error: null,
				progress: null,
				request: null,
				response: null,
				notification: null,
			},
		});

		assert.strictEqual(ollama.pending_actions.length, 1);
		assert.strictEqual(ollama.completed_actions.length, 0);

		// Add a completed action
		app.actions.add_from_json({
			method: 'ollama_list',
			action_event_data: {
				kind: 'local_call',
				phase: 'execute',
				step: 'handled',
				method: 'ollama_list',
				executor: 'frontend',
				input: {},
				output: {models: []},
				error: null,
				progress: null,
				request: null,
				response: null,
				notification: null,
			},
		});

		assert.strictEqual(ollama.pending_actions.length, 1);
		assert.strictEqual(ollama.completed_actions.length, 1);
	});

	test('should derive models from app.models', () => {
		const app = create_test_app();

		// Clear existing models and add test models
		app.models.clear();
		app.models.add({name: 'llama3.2:1b', provider_name: 'ollama'});
		app.models.add({name: 'gpt-4', provider_name: 'chatgpt'});
		app.models.add({name: 'gemma3:1b', provider_name: 'ollama'});

		const ollama = new Ollama({app});

		assert.strictEqual(ollama.models.length, 2);
		assert.strictEqual(ollama.models.length, 2);
		assert.include(ollama.model_names, 'llama3.2:1b');
		assert.include(ollama.model_names, 'gemma3:1b');
		assert.notInclude(ollama.model_names, 'gpt-4');
	});

	test('should update derived state correctly', () => {
		const app = create_test_app();

		// Clear and add ollama models
		app.models.clear();
		app.models.add({name: 'model_a', provider_name: 'ollama'});
		app.models.add({name: 'model_b', provider_name: 'ollama'});

		const ollama = new Ollama({app});
		ollama.list_status = 'success';

		assert.ok(ollama.available);
		assert.strictEqual(ollama.models.length, 2);
	});

	test('should clear model details', () => {
		const app = create_test_app();

		// Clear and add a test model with details
		app.models.clear();
		app.models.add({
			name: 'test_model',
			provider_name: 'ollama',
			ollama_show_response_loaded: true,
			ollama_show_response: {license: 'MIT'},
		});

		const ollama = new Ollama({app});
		const model = app.models.find_by_name('test_model');

		assert.isDefined(model);
		assert.ok(model!.ollama_show_response_loaded);
		assert.deepEqual(model!.ollama_show_response, {license: 'MIT'});

		ollama.clear_model_details(model!);

		assert.ok(model!.ollama_show_response === undefined);
		assert.ok(!model!.ollama_show_response_loaded);
		assert.ok(model!.ollama_show_response_error === undefined);
	});

	test('should handle model_by_name map', () => {
		const app = create_test_app();

		// Clear and add test models
		app.models.clear();
		app.models.add({name: 'test1', provider_name: 'ollama'});
		app.models.add({name: 'test2', provider_name: 'ollama'});
		app.models.add({name: 'other', provider_name: 'claude'});

		const ollama = new Ollama({app});

		assert.strictEqual(ollama.model_by_name.size, 2);
		assert.strictEqual(ollama.model_by_name.get('test1')?.name, 'test1');
		assert.strictEqual(ollama.model_by_name.get('test2')?.name, 'test2');
		assert.ok(!ollama.model_by_name.has('other'));
	});

	test('should initialize ps state correctly', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		assert.isNull(ollama.ps_response);
		assert.strictEqual(ollama.ps_status, 'initial');
		assert.isNull(ollama.ps_error);
		assert.ok(!ollama.ps_polling_enabled);
		assert.deepEqual(ollama.running_models, []);
		assert.strictEqual(ollama.running_model_names.size, 0);
	});

	test('should derive running models from ps response', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		// Set a mock ps response
		ollama.ps_response = {
			models: [
				{
					name: 'llama3.2:1b',
					model: 'llama3.2:1b',
					size: 1024 * 1024 * 1024,
					size_vram: 1024 * 1024 * 1024,
					digest: 'sha256:test1',
					modified_at: '2024-01-01T00:00:00Z',
					expires_at: '2024-01-01T01:00:00Z',
				},
				{
					name: 'gemma:2b',
					model: 'gemma:2b',
					size: 2 * 1024 * 1024 * 1024,
					size_vram: 2 * 1024 * 1024 * 1024,
					digest: 'sha256:test2',
					modified_at: '2024-01-01T00:00:00Z',
					expires_at: '2024-01-01T01:00:00Z',
				},
			],
		};

		assert.strictEqual(ollama.running_models.length, 2);
		assert.strictEqual(ollama.running_models[0]!.name, 'llama3.2:1b');
		assert.strictEqual(ollama.running_models[0]!.size_vram, 1024 * 1024 * 1024);
		assert.strictEqual(ollama.running_models[1]!.name, 'gemma:2b');
		assert.strictEqual(ollama.running_models[1]!.size_vram, 2 * 1024 * 1024 * 1024);

		assert.ok(ollama.running_model_names.has('llama3.2:1b'));
		assert.ok(ollama.running_model_names.has('gemma:2b'));
		assert.ok(!ollama.running_model_names.has('other'));
	});

	test('should handle ps polling state', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		// Start polling
		ollama.start_ps_polling();
		assert.ok(ollama.ps_polling_enabled);

		// Starting again should be safe
		ollama.start_ps_polling();
		assert.ok(ollama.ps_polling_enabled);

		// Stop polling
		ollama.stop_ps_polling();
		assert.ok(!ollama.ps_polling_enabled);

		// Stopping again should be safe
		ollama.stop_ps_polling();
		assert.ok(!ollama.ps_polling_enabled);
	});

	test('should filter ollama actions correctly', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		// Add various actions
		app.actions.add_from_json({
			method: 'ollama_pull',
			action_event_data: {
				kind: 'local_call',
				phase: 'execute',
				step: 'handled',
				method: 'ollama_pull',
				executor: 'frontend',
				input: {model: 'test1'},
				output: null,
				error: null,
				progress: null,
				request: null,
				response: null,
				notification: null,
			},
		});

		app.actions.add_from_json({
			method: 'ollama_list',
			action_event_data: {
				kind: 'local_call',
				phase: 'execute',
				step: 'handled',
				method: 'ollama_list',
				executor: 'frontend',
				input: {},
				output: null,
				error: null,
				progress: null,
				request: null,
				response: null,
				notification: null,
			},
		});

		app.actions.add_from_json({
			method: 'completion_create',
			action_event_data: {
				kind: 'request_response',
				phase: 'send_request',
				step: 'handled',
				method: 'completion_create',
				executor: 'frontend',
				input: {},
				output: null,
				error: null,
				progress: null,
				request: null,
				response: null,
				notification: null,
			},
		});

		assert.strictEqual(ollama.actions.length, 2);
		assert.include(
			ollama.actions.map((a) => a.method),
			'ollama_pull',
		);
		assert.include(
			ollama.actions.map((a) => a.method),
			'ollama_list',
		);
		assert.notInclude(
			ollama.actions.map((a) => a.method),
			'completion_create',
		);
	});

	test('should filter read operations when show_read_actions is false', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		// Add read and write operations
		app.actions.add_from_json({
			method: 'ollama_pull',
			action_event_data: {
				kind: 'local_call',
				phase: 'execute',
				step: 'handled',
				method: 'ollama_pull',
				executor: 'frontend',
				input: {model: 'test1'},
				output: null,
				error: null,
				progress: null,
				request: null,
				response: null,
				notification: null,
			},
		});

		app.actions.add_from_json({
			method: 'ollama_list',
			action_event_data: {
				kind: 'local_call',
				phase: 'execute',
				step: 'handled',
				method: 'ollama_list',
				executor: 'frontend',
				input: {},
				output: null,
				error: null,
				progress: null,
				request: null,
				response: null,
				notification: null,
			},
		});

		// With show_read_actions = false (default)
		assert.ok(!ollama.show_read_actions);
		assert.strictEqual(ollama.filtered_actions.length, 1);
		assert.strictEqual(ollama.filtered_actions[0]!.method, 'ollama_pull');

		// With show_read_actions = true
		ollama.show_read_actions = true;
		assert.strictEqual(ollama.filtered_actions.length, 2);
	});

	test('should handle action progress tracking', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		// Create an action with an initial action event that has progress
		const action = app.actions.add_from_json({
			method: 'ollama_pull',
			action_event_data: {
				kind: 'local_call',
				phase: 'execute',
				step: 'handling',
				method: 'ollama_pull',
				executor: 'frontend',
				input: {model: 'test_model'},
				output: null,
				error: null,
				progress: {status: 'downloading', completed: 50, total: 100},
				request: null,
				response: null,
				notification: null,
			},
		});

		assert.strictEqual(ollama.pending_actions.length, 1);
		assert.deepEqual(ollama.pending_actions[0]!.action_event_data?.progress, {
			status: 'downloading',
			completed: 50,
			total: 100,
		});

		// Create a real action event to observe
		const spec = app.lookup_action_spec('ollama_pull');
		if (!spec) throw new Error('Missing ollama_pull spec');
		const action_event = create_action_event(app, spec, {model: 'test_model'});
		action_event.parse();

		// Manually set up the action event to be in handling state
		action_event.set_data({
			...action_event.data,
			step: 'handling' as const,
			progress: {status: 'downloading', completed: 50, total: 100},
		} as any);

		// Set up the action to listen to the action event
		action.listen_to_action_event(action_event);

		// Update progress through the action event
		action_event.update_progress({status: 'downloading', completed: 75, total: 100});

		assert.deepEqual(action.action_event_data?.progress, {
			status: 'downloading',
			completed: 75,
			total: 100,
		});
		assert.deepEqual(ollama.pending_actions[0]!.action_event_data?.progress, {
			status: 'downloading',
			completed: 75,
			total: 100,
		});
	});

	test('should handle empty action lists', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		assert.strictEqual(ollama.actions.length, 0);
		assert.strictEqual(ollama.pending_actions.length, 0);
		assert.strictEqual(ollama.completed_actions.length, 0);
		assert.strictEqual(ollama.filtered_actions.length, 0);
	});

	test('should handle failed actions', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		app.actions.add_from_json({
			method: 'ollama_pull',
			action_event_data: {
				kind: 'local_call',
				phase: 'execute',
				step: 'failed',
				method: 'ollama_pull',
				executor: 'frontend',
				input: {model: 'test_model'},
				output: null,
				error: {code: -32603, message: 'Pull failed'},
				progress: null,
				request: null,
				response: null,
				notification: null,
			},
		});

		assert.strictEqual(ollama.pending_actions.length, 0);
		assert.strictEqual(ollama.completed_actions.length, 1);
		assert.strictEqual(ollama.completed_actions[0]!.action_event_data?.step, 'failed');
	});

	test('should only include ollama provider models', () => {
		const app = create_test_app();

		app.models.clear();
		app.models.add({name: 'claude_model', provider_name: 'claude'});
		app.models.add({name: 'ollama_model', provider_name: 'ollama'});
		app.models.add({name: 'chatgpt_model', provider_name: 'chatgpt'});

		const ollama = new Ollama({app});

		assert.strictEqual(ollama.models.length, 1);
		assert.strictEqual(ollama.models[0]!.name, 'ollama_model');
		assert.strictEqual(ollama.models[0]!.provider_name, 'ollama');
	});

	test('should handle ps response with empty models array', () => {
		const app = create_test_app();
		const ollama = new Ollama({app});

		ollama.ps_response = {models: []};

		assert.strictEqual(ollama.running_models.length, 0);
		assert.strictEqual(ollama.running_model_names.size, 0);
	});
});
