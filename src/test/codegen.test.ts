// @vitest-environment jsdom

import {test, describe, assert} from 'vitest';
import {
	ImportBuilder,
	get_executor_phases,
	get_handler_return_type,
	generate_phase_handlers,
} from '@fuzdev/fuz_app/actions/action_codegen.js';

import {
	ping_action_spec,
	session_load_action_spec,
	filer_change_action_spec,
	toggle_main_menu_action_spec,
	completion_create_action_spec,
} from '$lib/action_specs.js';

describe('ImportBuilder', () => {
	describe('type-only imports', () => {
		test('single module with type imports becomes import type', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/types.js', 'Foo');
			imports.add_type('$lib/types.js', 'Bar');

			assert.strictEqual(imports.build(), `import type {Bar, Foo} from '$lib/types.js';`);
		});

		test('add_types helper adds multiple types at once', () => {
			const imports = new ImportBuilder();

			imports.add_types('$lib/types.js', 'TypeA', 'TypeB', 'TypeC');

			assert.strictEqual(
				imports.build(),
				`import type {TypeA, TypeB, TypeC} from '$lib/types.js';`,
			);
		});

		test('empty imports returns empty string', () => {
			const imports = new ImportBuilder();

			assert.strictEqual(imports.build(), '');
			assert.ok(!imports.has_imports());
			assert.strictEqual(imports.import_count, 0);
		});
	});

	describe('mixed imports', () => {
		test('mixed types and values use individual type annotations', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/utils.js', 'helper');
			imports.add_type('$lib/utils.js', 'HelperType');
			imports.add('$lib/utils.js', 'another_helper');

			assert.strictEqual(
				imports.build(),
				`import {another_helper, helper, type HelperType} from '$lib/utils.js';`,
			);
		});

		test('value import prevents module from being type-only', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/mixed.js', 'TypeA');
			imports.add_type('$lib/mixed.js', 'TypeB');
			imports.add('$lib/mixed.js', 'value'); // This makes it mixed
			imports.add_type('$lib/mixed.js', 'TypeC');

			assert.strictEqual(
				imports.build(),
				`import {value, type TypeA, type TypeB, type TypeC} from '$lib/mixed.js';`,
			);
		});

		test('multiple values and types are sorted correctly', () => {
			const imports = new ImportBuilder();

			// Add in random order
			imports.add_type('$lib/mixed.js', 'ZType');
			imports.add('$lib/mixed.js', 'z_value');
			imports.add_type('$lib/mixed.js', 'AType');
			imports.add('$lib/mixed.js', 'a_value');
			imports.add_type('$lib/mixed.js', 'MType');
			imports.add('$lib/mixed.js', 'm_value');

			// Should sort values first (alphabetically), then types (alphabetically)
			assert.strictEqual(
				imports.build(),
				`import {a_value, m_value, z_value, type AType, type MType, type ZType} from '$lib/mixed.js';`,
			);
		});
	});

	describe('namespace imports', () => {
		test('namespace import is handled correctly', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/action_specs.js', '* as specs');

			assert.strictEqual(imports.build(), `import * as specs from '$lib/action_specs.js';`);
		});

		test('namespace import with other imports from same module', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/utils.js', '* as utils');
			imports.add('$lib/other.js', 'something');

			const result = imports.build();
			const lines = result.split('\n');

			assert.strictEqual(lines.length, 2);
			assert.include(lines, `import * as utils from '$lib/utils.js';`);
			assert.include(lines, `import {something} from '$lib/other.js';`);
		});

		test('add_many with namespace import', () => {
			const imports = new ImportBuilder();

			imports.add_many('$lib/helpers.js', '* as helpers');

			assert.strictEqual(imports.build(), `import * as helpers from '$lib/helpers.js';`);
		});

		test('namespace imports are not mixed with regular imports', () => {
			const imports = new ImportBuilder();

			// These should create separate import statements
			imports.add('$lib/module.js', '* as mod');
			imports.add('$lib/module.js', 'specific');

			// Namespace imports should be on their own line
			assert.strictEqual(imports.build(), `import * as mod from '$lib/module.js';`);
		});
	});

	describe('import precedence', () => {
		test('value import takes precedence over type import', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/utils.js', 'Item');
			imports.add('$lib/utils.js', 'Item'); // Upgrades to value

			assert.strictEqual(imports.build(), `import {Item} from '$lib/utils.js';`);
		});

		test('type import does not downgrade existing value import', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/utils.js', 'Item');
			imports.add_type('$lib/utils.js', 'Item'); // Should not downgrade

			assert.strictEqual(imports.build(), `import {Item} from '$lib/utils.js';`);
		});

		test('duplicate imports are deduplicated', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/types.js', 'Foo');
			imports.add_type('$lib/types.js', 'Foo');
			imports.add_type('$lib/types.js', 'Foo');

			assert.strictEqual(imports.build(), `import type {Foo} from '$lib/types.js';`);
		});

		test('namespace imports override previous imports', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/module.js', 'foo');
			imports.add('$lib/module.js', '* as module'); // Should override

			assert.strictEqual(imports.build(), `import * as module from '$lib/module.js';`);
		});
	});

	describe('multiple modules', () => {
		test('generates separate import statements per module', () => {
			const imports = new ImportBuilder();

			imports.add_types('$lib/types.js', 'TypeA', 'TypeB');
			imports.add('$lib/utils.js', 'util');
			imports.add_types('$lib/schemas.js', 'SchemaA', 'SchemaB');

			const result = imports.build();
			const lines = result.split('\n');

			assert.strictEqual(lines.length, 3);
			assert.include(lines, `import type {TypeA, TypeB} from '$lib/types.js';`);
			assert.include(lines, `import {util} from '$lib/utils.js';`);
			assert.include(lines, `import type {SchemaA, SchemaB} from '$lib/schemas.js';`);
		});

		test('imports are sorted alphabetically within modules', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/types.js', 'Zebra');
			imports.add_type('$lib/types.js', 'Apple');
			imports.add_type('$lib/types.js', 'Middle');

			assert.strictEqual(
				imports.build(),
				`import type {Apple, Middle, Zebra} from '$lib/types.js';`,
			);
		});

		test('handles imports with underscores and numbers correctly', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/types.js', '_Private_Type');
			imports.add_type('$lib/types.js', 'Type_1');
			imports.add_type('$lib/types.js', 'Type_2');
			imports.add_type('$lib/types.js', 'PUBLIC_TYPE');

			// Underscores sort before letters in most locales
			assert.strictEqual(
				imports.build(),
				`import type {PUBLIC_TYPE, Type_1, Type_2, _Private_Type} from '$lib/types.js';`,
			);
		});

		test('maintains module order based on first addition', () => {
			const imports = new ImportBuilder();

			// Add in specific order
			imports.add_type('$lib/third.js', 'Type3');
			imports.add_type('$lib/first.js', 'Type1');
			imports.add_type('$lib/second.js', 'Type2');

			// Then add more to existing modules
			imports.add_type('$lib/first.js', 'Type1b');
			imports.add_type('$lib/third.js', 'Type3b');

			const lines = imports.preview();

			// Module order should be based on insertion order
			assert.include(lines[0], '$lib/third.js');
			assert.include(lines[1], '$lib/first.js');
			assert.include(lines[2], '$lib/second.js');

			// But items within modules are sorted
			assert.strictEqual(lines[0], `import type {Type3, Type3b} from '$lib/third.js';`);
			assert.strictEqual(lines[1], `import type {Type1, Type1b} from '$lib/first.js';`);
		});

		test('handles mixed namespace and regular imports across modules', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/specs.js', '* as specs');
			imports.add_type('$lib/types.js', 'TypeA');
			imports.add('$lib/utils.js', 'helper');
			imports.add('$lib/schemas.js', '* as schemas');

			const lines = imports.preview();

			assert.strictEqual(lines.length, 4);
			assert.include(lines, `import * as specs from '$lib/specs.js';`);
			assert.include(lines, `import type {TypeA} from '$lib/types.js';`);
			assert.include(lines, `import {helper} from '$lib/utils.js';`);
			assert.include(lines, `import * as schemas from '$lib/schemas.js';`);
		});
	});

	describe('utility methods', () => {
		test('has_imports returns correct state', () => {
			const imports = new ImportBuilder();

			assert.ok(!imports.has_imports());

			imports.add_type('$lib/types.js', 'Foo');

			assert.ok(imports.has_imports());
		});

		test('import_count returns correct count', () => {
			const imports = new ImportBuilder();

			assert.strictEqual(imports.import_count, 0);

			imports.add_type('$lib/types.js', 'Foo');
			assert.strictEqual(imports.import_count, 1);

			imports.add('$lib/utils.js', 'bar');
			assert.strictEqual(imports.import_count, 2);

			// Adding to existing module doesn't increase count
			imports.add_type('$lib/types.js', 'Bar');
			assert.strictEqual(imports.import_count, 2);
		});

		test('preview returns array of import statements', () => {
			const imports = new ImportBuilder();

			imports.add_types('$lib/types.js', 'Foo', 'Bar');
			imports.add('$lib/utils.js', 'helper');

			const preview = imports.preview();

			assert.strictEqual(preview.length, 2);
			assert.strictEqual(preview[0], `import type {Bar, Foo} from '$lib/types.js';`);
			assert.strictEqual(preview[1], `import {helper} from '$lib/utils.js';`);
		});

		test('clear removes all imports', () => {
			const imports = new ImportBuilder();

			imports.add_types('$lib/types.js', 'Foo', 'Bar');
			imports.add('$lib/utils.js', 'helper');

			assert.strictEqual(imports.import_count, 2);

			imports.clear();

			assert.strictEqual(imports.import_count, 0);
			assert.strictEqual(imports.build(), '');
		});

		test('chaining works correctly', () => {
			const imports = new ImportBuilder();

			const result = imports
				.add_type('$lib/types.js', 'Foo')
				.add('$lib/utils.js', 'helper')
				.add_types('$lib/types.js', 'Bar', 'Baz')
				.clear()
				.add_type('$lib/final.js', 'Final');

			assert.strictEqual(result, imports); // Chainable
			assert.strictEqual(imports.build(), `import type {Final} from '$lib/final.js';`);
		});
	});

	describe('add_many helper', () => {
		test('adds multiple value imports', () => {
			const imports = new ImportBuilder();

			imports.add_many('$lib/utils.js', 'util_a', 'util_b', 'util_c');

			assert.strictEqual(imports.build(), `import {util_a, util_b, util_c} from '$lib/utils.js';`);
		});

		test('add_many can handle namespace imports', () => {
			const imports = new ImportBuilder();

			imports.add_many('$lib/all.js', '* as all', 'specific');

			// Only the namespace import should be used
			assert.strictEqual(imports.build(), `import * as all from '$lib/all.js';`);
		});
	});

	describe('edge cases', () => {
		test('handles empty string imports gracefully', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/module.js', '');

			// Empty imports should be ignored
			assert.strictEqual(imports.build(), '');
			assert.ok(!imports.has_imports());
		});

		test('handles special characters in import names', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/module.js', '$special');
			imports.add('$lib/module.js', '_underscore');

			assert.strictEqual(imports.build(), `import {$special, _underscore} from '$lib/module.js';`);
		});
	});
});

describe('get_executor_phases', () => {
	describe('request_response actions', () => {
		test('frontend initiator - ping spec', () => {
			// ping has initiator: 'both'
			assert.deepEqual(get_executor_phases(ping_action_spec, 'frontend'), [
				'send_request',
				'receive_response',
				'send_error',
				'receive_error',
				'receive_request',
				'send_response',
			]);
			assert.deepEqual(get_executor_phases(ping_action_spec, 'backend'), [
				'send_request',
				'receive_response',
				'send_error',
				'receive_error',
				'receive_request',
				'send_response',
			]);
		});

		test('frontend initiator - session_load spec', () => {
			// load_session has initiator: 'frontend'
			assert.deepEqual(get_executor_phases(session_load_action_spec, 'frontend'), [
				'send_request',
				'receive_response',
				'send_error',
				'receive_error',
			]);
			assert.deepEqual(get_executor_phases(session_load_action_spec, 'backend'), [
				'receive_request',
				'send_response',
				'send_error',
			]);
		});

		test('frontend initiator - completion_create spec', () => {
			// create_completion has initiator: 'frontend'
			assert.deepEqual(get_executor_phases(completion_create_action_spec, 'frontend'), [
				'send_request',
				'receive_response',
				'send_error',
				'receive_error',
			]);
			assert.deepEqual(get_executor_phases(completion_create_action_spec, 'backend'), [
				'receive_request',
				'send_response',
				'send_error',
			]);
		});
	});

	describe('remote_notification actions', () => {
		test('backend initiator - filer_change spec', () => {
			// filer_change has initiator: 'backend'
			assert.deepEqual(get_executor_phases(filer_change_action_spec, 'frontend'), ['receive']);
			assert.deepEqual(get_executor_phases(filer_change_action_spec, 'backend'), ['send']);
		});
	});

	describe('local_call actions', () => {
		test('frontend initiator - toggle_main_menu spec', () => {
			// toggle_main_menu has initiator: 'frontend'
			assert.deepEqual(get_executor_phases(toggle_main_menu_action_spec, 'frontend'), ['execute']);
			assert.deepEqual(get_executor_phases(toggle_main_menu_action_spec, 'backend'), []);
		});
	});

	describe('edge cases', () => {
		test('phases are returned in correct order', () => {
			const frontend_phases = get_executor_phases(ping_action_spec, 'frontend');
			// Send phases should come before receive phases
			assert.ok(
				frontend_phases.indexOf('send_request') < frontend_phases.indexOf('receive_request'),
			);
		});

		test('returns empty array for invalid initiator', () => {
			const spec_with_backend_only = {
				...toggle_main_menu_action_spec,
				initiator: 'backend' as const,
			};
			assert.deepEqual(get_executor_phases(spec_with_backend_only, 'frontend'), []);
		});
	});
});

describe('get_handler_return_type', () => {
	describe('request_response actions', () => {
		test('receive_request phase returns output with Promise and adds import', () => {
			const imports = new ImportBuilder();

			// ping_action_spec is a request/response action
			const result = get_handler_return_type(ping_action_spec, 'receive_request', imports, './');
			assert.strictEqual(result, `ActionOutputs['ping'] | Promise<ActionOutputs['ping']>`);

			// Check that ActionOutputs was added to imports
			const built = imports.build();
			assert.include(built, 'ActionOutputs');
			assert.include(built, './action_collections.js');
		});

		test('other phases return void and do not add imports', () => {
			const imports = new ImportBuilder();

			assert.strictEqual(
				get_handler_return_type(session_load_action_spec, 'send_request', imports, './'),
				'void | Promise<void>',
			);
			assert.strictEqual(
				get_handler_return_type(session_load_action_spec, 'send_response', imports, './'),
				'void | Promise<void>',
			);
			assert.strictEqual(
				get_handler_return_type(session_load_action_spec, 'receive_response', imports, './'),
				'void | Promise<void>',
			);

			// Should not add ActionOutputs for void returns
			assert.strictEqual(imports.build(), '');
		});
	});

	describe('local_call actions', () => {
		test('execute phase returns output for sync action', () => {
			const imports = new ImportBuilder();

			// toggle_main_menu is a sync local_call (async: false)
			const result = get_handler_return_type(
				toggle_main_menu_action_spec,
				'execute',
				imports,
				'./',
			);
			assert.strictEqual(result, `ActionOutputs['toggle_main_menu']`);

			// Should add ActionOutputs import
			assert.include(imports.build(), 'ActionOutputs');
		});

		test('execute phase returns Promise for async local_call', () => {
			const imports = new ImportBuilder();

			// Create an async local_call spec
			const async_local_spec = {
				...toggle_main_menu_action_spec,
				async: true,
			};

			const result = get_handler_return_type(async_local_spec, 'execute', imports, './');
			assert.strictEqual(
				result,
				`ActionOutputs['toggle_main_menu'] | Promise<ActionOutputs['toggle_main_menu']>`,
			);
		});
	});

	describe('remote_notification actions', () => {
		test('all phases return void', () => {
			const imports = new ImportBuilder();

			assert.strictEqual(
				get_handler_return_type(filer_change_action_spec, 'send', imports, './'),
				'void | Promise<void>',
			);
			assert.strictEqual(
				get_handler_return_type(filer_change_action_spec, 'receive', imports, './'),
				'void | Promise<void>',
			);

			// Should not add imports for void returns
			assert.strictEqual(imports.build(), '');
		});
	});

	describe('import management', () => {
		test('adds imports only when needed', () => {
			const imports = new ImportBuilder();

			// First call adds import
			get_handler_return_type(ping_action_spec, 'receive_request', imports, './');
			assert.strictEqual(imports.import_count, 1);

			// Second call doesn't add duplicate
			get_handler_return_type(session_load_action_spec, 'receive_request', imports, './');
			assert.strictEqual(imports.import_count, 1);

			// Void return doesn't add import
			get_handler_return_type(ping_action_spec, 'send_request', imports, './');
			assert.strictEqual(imports.import_count, 1);
		});
	});
});

describe('generate_phase_handlers', () => {
	test('generates never for actions with no valid phases', () => {
		// toggle_main_menu on backend should have no valid phases
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(toggle_main_menu_action_spec, 'backend', imports);

		assert.strictEqual(result, 'toggle_main_menu?: never');
		assert.ok(!imports.has_imports());
	});

	test('generates handlers for request_response action', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(session_load_action_spec, 'frontend', imports);

		assert.include(result, 'session_load?: {');
		assert.include(result, 'send_request?:');
		assert.include(result, 'receive_response?:');
		assert.notInclude(result, 'receive_request');

		// Check imports were added
		assert.ok(imports.has_imports());
		const import_str = imports.build();
		assert.include(import_str, 'ActionEvent');
		assert.include(import_str, 'Frontend');
	});

	test('generates handlers for notification action', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(filer_change_action_spec, 'backend', imports);

		assert.include(result, 'filer_change?: {');
		assert.include(result, 'send?:');
		assert.notInclude(result, 'receive?:');

		const import_str = imports.build();
		assert.include(import_str, 'ActionEvent');
		assert.include(import_str, 'Backend');
	});

	test('generates handlers for local_call action', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(toggle_main_menu_action_spec, 'frontend', imports);

		assert.include(result, 'toggle_main_menu?: {');
		assert.include(result, 'execute?:');
		assert.include(result, `ActionOutputs['toggle_main_menu']`);
		assert.notInclude(result, 'Promise'); // It's a sync action

		const import_str = imports.build();
		assert.include(import_str, 'ActionEvent');
		assert.include(import_str, 'ActionOutputs'); // Added by get_handler_return_type
		assert.include(import_str, 'Frontend');
	});

	test('uses type-only imports when appropriate', () => {
		const imports = new ImportBuilder();
		generate_phase_handlers(completion_create_action_spec, 'backend', imports);

		const import_str = imports.build();
		// All imports should be type-only
		const lines = import_str.split('\n');
		lines.forEach((line) => {
			if (line.trim()) {
				assert.match(line, /^import type/);
			}
		});
	});

	test('generates all phases for both initiator', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(ping_action_spec, 'frontend', imports);

		assert.include(result, 'send_request?:');
		assert.include(result, 'receive_response?:');
		assert.include(result, 'receive_request?:');
		assert.include(result, 'send_response?:');
	});

	test('uses phase and step type parameters in handler signature', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(ping_action_spec, 'frontend', imports);

		// Should use the new type parameter syntax instead of data override
		assert.include(
			result,
			`action_event: ActionEvent<'ping', Frontend, 'send_request', 'handling'>`,
		);
		assert.include(
			result,
			`action_event: ActionEvent<'ping', Frontend, 'receive_response', 'handling'>`,
		);
		assert.include(
			result,
			`action_event: ActionEvent<'ping', Frontend, 'receive_request', 'handling'>`,
		);
		assert.include(
			result,
			`action_event: ActionEvent<'ping', Frontend, 'send_response', 'handling'>`,
		);
	});

	test('handles ActionOutputs import for handlers that return values', () => {
		const imports = new ImportBuilder();
		// ping has receive_request handler on backend which returns output
		const result = generate_phase_handlers(ping_action_spec, 'backend', imports);

		assert.include(result, 'receive_request?:');
		assert.include(result, `ActionOutputs['ping'] | Promise<ActionOutputs['ping']>`);

		// Check that ActionOutputs was imported
		const import_str = imports.build();
		assert.include(import_str, 'ActionOutputs');
	});

	test('handler formatting is consistent', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(ping_action_spec, 'frontend', imports);

		// Check indentation and formatting
		const lines = result.split('\n');
		assert.match(lines[0]!, /^ping\?: \{$/);
		assert.match(lines[1]!, /^\t\t/); // Two tabs for handler definitions
		assert.match(lines[lines.length - 1]!, /^\t\}$/); // One tab for closing brace
	});

	test('imports are deduplicated across multiple specs', () => {
		const imports = new ImportBuilder();

		// Generate handlers for multiple specs
		generate_phase_handlers(ping_action_spec, 'frontend', imports);
		generate_phase_handlers(session_load_action_spec, 'frontend', imports);
		generate_phase_handlers(toggle_main_menu_action_spec, 'frontend', imports);

		const import_str = imports.build();

		// Should have exactly one import of each type
		assert.strictEqual(import_str.match(/ActionEvent/g)?.length, 1);
		assert.strictEqual(import_str.match(/Frontend/g)?.length, 1);
		assert.strictEqual(import_str.match(/ActionOutputs/g)?.length, 1);
	});

	test('frontend generates correct relative import paths', () => {
		const imports = new ImportBuilder();
		generate_phase_handlers(ping_action_spec, 'frontend', imports);

		const import_str = imports.build();
		assert.include(import_str, "from './action_event.js'");
		assert.include(import_str, "from './frontend.svelte.js'");
		assert.include(import_str, "from './action_collections.js'");
	});

	test('backend generates correct relative import paths', () => {
		const imports = new ImportBuilder();
		generate_phase_handlers(ping_action_spec, 'backend', imports);

		const import_str = imports.build();
		assert.include(import_str, "from '../action_event.js'");
		assert.include(import_str, "from './backend.js'");
		assert.include(import_str, "from '../action_collections.js'");
	});
});
