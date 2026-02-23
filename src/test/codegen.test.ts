// @slop Claude Opus 4

// @vitest-environment jsdom

import {test, expect, describe} from 'vitest';
import {
	ImportBuilder,
	get_executor_phases,
	get_handler_return_type,
	generate_phase_handlers,
} from '@fuzdev/fuz_app/action_codegen.js';

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

			expect(imports.build()).toBe(`import type {Bar, Foo} from '$lib/types.js';`);
		});

		test('add_types helper adds multiple types at once', () => {
			const imports = new ImportBuilder();

			imports.add_types('$lib/types.js', 'TypeA', 'TypeB', 'TypeC');

			expect(imports.build()).toBe(`import type {TypeA, TypeB, TypeC} from '$lib/types.js';`);
		});

		test('empty imports returns empty string', () => {
			const imports = new ImportBuilder();

			expect(imports.build()).toBe('');
			expect(imports.has_imports()).toBe(false);
			expect(imports.import_count).toBe(0);
		});
	});

	describe('mixed imports', () => {
		test('mixed types and values use individual type annotations', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/utils.js', 'helper');
			imports.add_type('$lib/utils.js', 'HelperType');
			imports.add('$lib/utils.js', 'another_helper');

			expect(imports.build()).toBe(
				`import {another_helper, helper, type HelperType} from '$lib/utils.js';`,
			);
		});

		test('value import prevents module from being type-only', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/mixed.js', 'TypeA');
			imports.add_type('$lib/mixed.js', 'TypeB');
			imports.add('$lib/mixed.js', 'value'); // This makes it mixed
			imports.add_type('$lib/mixed.js', 'TypeC');

			expect(imports.build()).toBe(
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
			expect(imports.build()).toBe(
				`import {a_value, m_value, z_value, type AType, type MType, type ZType} from '$lib/mixed.js';`,
			);
		});
	});

	describe('namespace imports', () => {
		test('namespace import is handled correctly', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/action_specs.js', '* as specs');

			expect(imports.build()).toBe(`import * as specs from '$lib/action_specs.js';`);
		});

		test('namespace import with other imports from same module', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/utils.js', '* as utils');
			imports.add('$lib/other.js', 'something');

			const result = imports.build();
			const lines = result.split('\n');

			expect(lines).toHaveLength(2);
			expect(lines).toContain(`import * as utils from '$lib/utils.js';`);
			expect(lines).toContain(`import {something} from '$lib/other.js';`);
		});

		test('add_many with namespace import', () => {
			const imports = new ImportBuilder();

			imports.add_many('$lib/helpers.js', '* as helpers');

			expect(imports.build()).toBe(`import * as helpers from '$lib/helpers.js';`);
		});

		test('namespace imports are not mixed with regular imports', () => {
			const imports = new ImportBuilder();

			// These should create separate import statements
			imports.add('$lib/module.js', '* as mod');
			imports.add('$lib/module.js', 'specific');

			// Namespace imports should be on their own line
			expect(imports.build()).toBe(`import * as mod from '$lib/module.js';`);
		});
	});

	describe('import precedence', () => {
		test('value import takes precedence over type import', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/utils.js', 'Item');
			imports.add('$lib/utils.js', 'Item'); // Upgrades to value

			expect(imports.build()).toBe(`import {Item} from '$lib/utils.js';`);
		});

		test('type import does not downgrade existing value import', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/utils.js', 'Item');
			imports.add_type('$lib/utils.js', 'Item'); // Should not downgrade

			expect(imports.build()).toBe(`import {Item} from '$lib/utils.js';`);
		});

		test('duplicate imports are deduplicated', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/types.js', 'Foo');
			imports.add_type('$lib/types.js', 'Foo');
			imports.add_type('$lib/types.js', 'Foo');

			expect(imports.build()).toBe(`import type {Foo} from '$lib/types.js';`);
		});

		test('namespace imports override previous imports', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/module.js', 'foo');
			imports.add('$lib/module.js', '* as module'); // Should override

			expect(imports.build()).toBe(`import * as module from '$lib/module.js';`);
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

			expect(lines).toHaveLength(3);
			expect(lines).toContain(`import type {TypeA, TypeB} from '$lib/types.js';`);
			expect(lines).toContain(`import {util} from '$lib/utils.js';`);
			expect(lines).toContain(`import type {SchemaA, SchemaB} from '$lib/schemas.js';`);
		});

		test('imports are sorted alphabetically within modules', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/types.js', 'Zebra');
			imports.add_type('$lib/types.js', 'Apple');
			imports.add_type('$lib/types.js', 'Middle');

			expect(imports.build()).toBe(`import type {Apple, Middle, Zebra} from '$lib/types.js';`);
		});

		test('handles imports with underscores and numbers correctly', () => {
			const imports = new ImportBuilder();

			imports.add_type('$lib/types.js', '_Private_Type');
			imports.add_type('$lib/types.js', 'Type_1');
			imports.add_type('$lib/types.js', 'Type_2');
			imports.add_type('$lib/types.js', 'PUBLIC_TYPE');

			// Underscores sort before letters in most locales
			expect(imports.build()).toBe(
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
			expect(lines[0]).toContain('$lib/third.js');
			expect(lines[1]).toContain('$lib/first.js');
			expect(lines[2]).toContain('$lib/second.js');

			// But items within modules are sorted
			expect(lines[0]).toBe(`import type {Type3, Type3b} from '$lib/third.js';`);
			expect(lines[1]).toBe(`import type {Type1, Type1b} from '$lib/first.js';`);
		});

		test('handles mixed namespace and regular imports across modules', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/specs.js', '* as specs');
			imports.add_type('$lib/types.js', 'TypeA');
			imports.add('$lib/utils.js', 'helper');
			imports.add('$lib/schemas.js', '* as schemas');

			const lines = imports.preview();

			expect(lines).toHaveLength(4);
			expect(lines).toContain(`import * as specs from '$lib/specs.js';`);
			expect(lines).toContain(`import type {TypeA} from '$lib/types.js';`);
			expect(lines).toContain(`import {helper} from '$lib/utils.js';`);
			expect(lines).toContain(`import * as schemas from '$lib/schemas.js';`);
		});
	});

	describe('utility methods', () => {
		test('has_imports returns correct state', () => {
			const imports = new ImportBuilder();

			expect(imports.has_imports()).toBe(false);

			imports.add_type('$lib/types.js', 'Foo');

			expect(imports.has_imports()).toBe(true);
		});

		test('import_count returns correct count', () => {
			const imports = new ImportBuilder();

			expect(imports.import_count).toBe(0);

			imports.add_type('$lib/types.js', 'Foo');
			expect(imports.import_count).toBe(1);

			imports.add('$lib/utils.js', 'bar');
			expect(imports.import_count).toBe(2);

			// Adding to existing module doesn't increase count
			imports.add_type('$lib/types.js', 'Bar');
			expect(imports.import_count).toBe(2);
		});

		test('preview returns array of import statements', () => {
			const imports = new ImportBuilder();

			imports.add_types('$lib/types.js', 'Foo', 'Bar');
			imports.add('$lib/utils.js', 'helper');

			const preview = imports.preview();

			expect(preview).toHaveLength(2);
			expect(preview[0]).toBe(`import type {Bar, Foo} from '$lib/types.js';`);
			expect(preview[1]).toBe(`import {helper} from '$lib/utils.js';`);
		});

		test('clear removes all imports', () => {
			const imports = new ImportBuilder();

			imports.add_types('$lib/types.js', 'Foo', 'Bar');
			imports.add('$lib/utils.js', 'helper');

			expect(imports.import_count).toBe(2);

			imports.clear();

			expect(imports.import_count).toBe(0);
			expect(imports.build()).toBe('');
		});

		test('chaining works correctly', () => {
			const imports = new ImportBuilder();

			const result = imports
				.add_type('$lib/types.js', 'Foo')
				.add('$lib/utils.js', 'helper')
				.add_types('$lib/types.js', 'Bar', 'Baz')
				.clear()
				.add_type('$lib/final.js', 'Final');

			expect(result).toBe(imports); // Chainable
			expect(imports.build()).toBe(`import type {Final} from '$lib/final.js';`);
		});
	});

	describe('add_many helper', () => {
		test('adds multiple value imports', () => {
			const imports = new ImportBuilder();

			imports.add_many('$lib/utils.js', 'util_a', 'util_b', 'util_c');

			expect(imports.build()).toBe(`import {util_a, util_b, util_c} from '$lib/utils.js';`);
		});

		test('add_many can handle namespace imports', () => {
			const imports = new ImportBuilder();

			imports.add_many('$lib/all.js', '* as all', 'specific');

			// Only the namespace import should be used
			expect(imports.build()).toBe(`import * as all from '$lib/all.js';`);
		});
	});

	describe('edge cases', () => {
		test('handles empty string imports gracefully', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/module.js', '');

			// Empty imports should be ignored
			expect(imports.build()).toBe('');
			expect(imports.has_imports()).toBe(false);
		});

		test('handles special characters in import names', () => {
			const imports = new ImportBuilder();

			imports.add('$lib/module.js', '$special');
			imports.add('$lib/module.js', '_underscore');

			expect(imports.build()).toBe(`import {$special, _underscore} from '$lib/module.js';`);
		});
	});
});

describe('get_executor_phases', () => {
	describe('request_response actions', () => {
		test('frontend initiator - ping spec', () => {
			// ping has initiator: 'both'
			expect(get_executor_phases(ping_action_spec, 'frontend')).toEqual([
				'send_request',
				'receive_response',
				'send_error',
				'receive_error',
				'receive_request',
				'send_response',
			]);
			expect(get_executor_phases(ping_action_spec, 'backend')).toEqual([
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
			expect(get_executor_phases(session_load_action_spec, 'frontend')).toEqual([
				'send_request',
				'receive_response',
				'send_error',
				'receive_error',
			]);
			expect(get_executor_phases(session_load_action_spec, 'backend')).toEqual([
				'receive_request',
				'send_response',
				'send_error',
			]);
		});

		test('frontend initiator - completion_create spec', () => {
			// create_completion has initiator: 'frontend'
			expect(get_executor_phases(completion_create_action_spec, 'frontend')).toEqual([
				'send_request',
				'receive_response',
				'send_error',
				'receive_error',
			]);
			expect(get_executor_phases(completion_create_action_spec, 'backend')).toEqual([
				'receive_request',
				'send_response',
				'send_error',
			]);
		});
	});

	describe('remote_notification actions', () => {
		test('backend initiator - filer_change spec', () => {
			// filer_change has initiator: 'backend'
			expect(get_executor_phases(filer_change_action_spec, 'frontend')).toEqual(['receive']);
			expect(get_executor_phases(filer_change_action_spec, 'backend')).toEqual(['send']);
		});
	});

	describe('local_call actions', () => {
		test('frontend initiator - toggle_main_menu spec', () => {
			// toggle_main_menu has initiator: 'frontend'
			expect(get_executor_phases(toggle_main_menu_action_spec, 'frontend')).toEqual(['execute']);
			expect(get_executor_phases(toggle_main_menu_action_spec, 'backend')).toEqual([]);
		});
	});

	describe('edge cases', () => {
		test('phases are returned in correct order', () => {
			const frontend_phases = get_executor_phases(ping_action_spec, 'frontend');
			// Send phases should come before receive phases
			expect(frontend_phases.indexOf('send_request')).toBeLessThan(
				frontend_phases.indexOf('receive_request'),
			);
		});

		test('returns empty array for invalid initiator', () => {
			const spec_with_backend_only = {
				...toggle_main_menu_action_spec,
				initiator: 'backend' as const,
			};
			expect(get_executor_phases(spec_with_backend_only, 'frontend')).toEqual([]);
		});
	});
});

describe('get_handler_return_type', () => {
	describe('request_response actions', () => {
		test('receive_request phase returns output with Promise and adds import', () => {
			const imports = new ImportBuilder();

			// ping_action_spec is a request/response action
			const result = get_handler_return_type(ping_action_spec, 'receive_request', imports, './');
			expect(result).toBe(`ActionOutputs['ping'] | Promise<ActionOutputs['ping']>`);

			// Check that ActionOutputs was added to imports
			const built = imports.build();
			expect(built).toContain('ActionOutputs');
			expect(built).toContain('./action_collections.js');
		});

		test('other phases return void and do not add imports', () => {
			const imports = new ImportBuilder();

			expect(get_handler_return_type(session_load_action_spec, 'send_request', imports, './')).toBe(
				'void | Promise<void>',
			);
			expect(
				get_handler_return_type(session_load_action_spec, 'send_response', imports, './'),
			).toBe('void | Promise<void>');
			expect(
				get_handler_return_type(session_load_action_spec, 'receive_response', imports, './'),
			).toBe('void | Promise<void>');

			// Should not add ActionOutputs for void returns
			expect(imports.build()).toBe('');
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
			expect(result).toBe(`ActionOutputs['toggle_main_menu']`);

			// Should add ActionOutputs import
			expect(imports.build()).toContain('ActionOutputs');
		});

		test('execute phase returns Promise for async local_call', () => {
			const imports = new ImportBuilder();

			// Create an async local_call spec
			const async_local_spec = {
				...toggle_main_menu_action_spec,
				async: true,
			};

			const result = get_handler_return_type(async_local_spec, 'execute', imports, './');
			expect(result).toBe(
				`ActionOutputs['toggle_main_menu'] | Promise<ActionOutputs['toggle_main_menu']>`,
			);
		});
	});

	describe('remote_notification actions', () => {
		test('all phases return void', () => {
			const imports = new ImportBuilder();

			expect(get_handler_return_type(filer_change_action_spec, 'send', imports, './')).toBe(
				'void | Promise<void>',
			);
			expect(get_handler_return_type(filer_change_action_spec, 'receive', imports, './')).toBe(
				'void | Promise<void>',
			);

			// Should not add imports for void returns
			expect(imports.build()).toBe('');
		});
	});

	describe('import management', () => {
		test('adds imports only when needed', () => {
			const imports = new ImportBuilder();

			// First call adds import
			get_handler_return_type(ping_action_spec, 'receive_request', imports, './');
			expect(imports.import_count).toBe(1);

			// Second call doesn't add duplicate
			get_handler_return_type(session_load_action_spec, 'receive_request', imports, './');
			expect(imports.import_count).toBe(1);

			// Void return doesn't add import
			get_handler_return_type(ping_action_spec, 'send_request', imports, './');
			expect(imports.import_count).toBe(1);
		});
	});
});

describe('generate_phase_handlers', () => {
	test('generates never for actions with no valid phases', () => {
		// toggle_main_menu on backend should have no valid phases
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(toggle_main_menu_action_spec, 'backend', imports);

		expect(result).toBe('toggle_main_menu?: never');
		expect(imports.has_imports()).toBe(false);
	});

	test('generates handlers for request_response action', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(session_load_action_spec, 'frontend', imports);

		expect(result).toContain('session_load?: {');
		expect(result).toContain('send_request?:');
		expect(result).toContain('receive_response?:');
		expect(result).not.toContain('receive_request');

		// Check imports were added
		expect(imports.has_imports()).toBe(true);
		const import_str = imports.build();
		expect(import_str).toContain('ActionEvent');
		expect(import_str).toContain('Frontend');
	});

	test('generates handlers for notification action', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(filer_change_action_spec, 'backend', imports);

		expect(result).toContain('filer_change?: {');
		expect(result).toContain('send?:');
		expect(result).not.toContain('receive?:');

		const import_str = imports.build();
		expect(import_str).toContain('ActionEvent');
		expect(import_str).toContain('Backend');
	});

	test('generates handlers for local_call action', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(toggle_main_menu_action_spec, 'frontend', imports);

		expect(result).toContain('toggle_main_menu?: {');
		expect(result).toContain('execute?:');
		expect(result).toContain(`ActionOutputs['toggle_main_menu']`);
		expect(result).not.toContain('Promise'); // It's a sync action

		const import_str = imports.build();
		expect(import_str).toContain('ActionEvent');
		expect(import_str).toContain('ActionOutputs'); // Added by get_handler_return_type
		expect(import_str).toContain('Frontend');
	});

	test('uses type-only imports when appropriate', () => {
		const imports = new ImportBuilder();
		generate_phase_handlers(completion_create_action_spec, 'backend', imports);

		const import_str = imports.build();
		// All imports should be type-only
		const lines = import_str.split('\n');
		lines.forEach((line) => {
			if (line.trim()) {
				expect(line).toMatch(/^import type/);
			}
		});
	});

	test('generates all phases for both initiator', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(ping_action_spec, 'frontend', imports);

		expect(result).toContain('send_request?:');
		expect(result).toContain('receive_response?:');
		expect(result).toContain('receive_request?:');
		expect(result).toContain('send_response?:');
	});

	test('uses phase and step type parameters in handler signature', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(ping_action_spec, 'frontend', imports);

		// Should use the new type parameter syntax instead of data override
		expect(result).toContain(
			`action_event: ActionEvent<'ping', Frontend, 'send_request', 'handling'>`,
		);
		expect(result).toContain(
			`action_event: ActionEvent<'ping', Frontend, 'receive_response', 'handling'>`,
		);
		expect(result).toContain(
			`action_event: ActionEvent<'ping', Frontend, 'receive_request', 'handling'>`,
		);
		expect(result).toContain(
			`action_event: ActionEvent<'ping', Frontend, 'send_response', 'handling'>`,
		);
	});

	test('handles ActionOutputs import for handlers that return values', () => {
		const imports = new ImportBuilder();
		// ping has receive_request handler on backend which returns output
		const result = generate_phase_handlers(ping_action_spec, 'backend', imports);

		expect(result).toContain('receive_request?:');
		expect(result).toContain(`ActionOutputs['ping'] | Promise<ActionOutputs['ping']>`);

		// Check that ActionOutputs was imported
		const import_str = imports.build();
		expect(import_str).toContain('ActionOutputs');
	});

	test('handler formatting is consistent', () => {
		const imports = new ImportBuilder();
		const result = generate_phase_handlers(ping_action_spec, 'frontend', imports);

		// Check indentation and formatting
		const lines = result.split('\n');
		expect(lines[0]).toMatch(/^ping\?: \{$/);
		expect(lines[1]).toMatch(/^\t\t/); // Two tabs for handler definitions
		expect(lines[lines.length - 1]).toMatch(/^\t\}$/); // One tab for closing brace
	});

	test('imports are deduplicated across multiple specs', () => {
		const imports = new ImportBuilder();

		// Generate handlers for multiple specs
		generate_phase_handlers(ping_action_spec, 'frontend', imports);
		generate_phase_handlers(session_load_action_spec, 'frontend', imports);
		generate_phase_handlers(toggle_main_menu_action_spec, 'frontend', imports);

		const import_str = imports.build();

		// Should have exactly one import of each type
		expect(import_str.match(/ActionEvent/g)?.length).toBe(1);
		expect(import_str.match(/Frontend/g)?.length).toBe(1);
		expect(import_str.match(/ActionOutputs/g)?.length).toBe(1);
	});

	test('frontend generates correct relative import paths', () => {
		const imports = new ImportBuilder();
		generate_phase_handlers(ping_action_spec, 'frontend', imports);

		const import_str = imports.build();
		expect(import_str).toContain("from './action_event.js'");
		expect(import_str).toContain("from './frontend.svelte.js'");
		expect(import_str).toContain("from './action_collections.js'");
	});

	test('backend generates correct relative import paths', () => {
		const imports = new ImportBuilder();
		generate_phase_handlers(ping_action_spec, 'backend', imports);

		const import_str = imports.build();
		expect(import_str).toContain("from '../action_event.js'");
		expect(import_str).toContain("from './backend.js'");
		expect(import_str).toContain("from '../action_collections.js'");
	});
});
