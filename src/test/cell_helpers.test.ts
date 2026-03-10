import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {get_schema_class_info} from '$lib/cell_helpers.js';

describe('get_schema_class_info', () => {
	test('handles null or undefined schemas', () => {
		assert.isNull(get_schema_class_info(null));
		assert.isNull(get_schema_class_info(undefined));
	});

	test('identifies basic schema types correctly', () => {
		const string_schema = z.string();
		const number_schema = z.number();
		const boolean_schema = z.boolean();

		const string_info = get_schema_class_info(string_schema);
		const number_info = get_schema_class_info(number_schema);
		const boolean_info = get_schema_class_info(boolean_schema);

		assert.strictEqual(string_info?.type, 'ZodString');
		assert.ok(!string_info?.is_array);

		assert.strictEqual(number_info?.type, 'ZodNumber');
		assert.ok(!number_info?.is_array);

		assert.strictEqual(boolean_info?.type, 'ZodBoolean');
		assert.ok(!boolean_info?.is_array);
	});

	test('identifies array schemas correctly', () => {
		const string_array = z.array(z.string());
		const number_array = z.array(z.number());
		const object_array = z.array(z.object({name: z.string()}));

		const string_array_info = get_schema_class_info(string_array);
		const number_array_info = get_schema_class_info(number_array);
		const object_array_info = get_schema_class_info(object_array);

		// Test array identification
		assert.strictEqual(string_array_info?.type, 'ZodArray');
		assert.ok(string_array_info?.is_array);

		assert.strictEqual(number_array_info?.type, 'ZodArray');
		assert.ok(number_array_info?.is_array);

		assert.strictEqual(object_array_info?.type, 'ZodArray');
		assert.ok(object_array_info?.is_array);
	});

	test('handles default wrapped schemas', () => {
		const string_with_default = z.string().default('default');
		const array_with_default = z.array(z.string()).default([]);

		const string_default_info = get_schema_class_info(string_with_default);
		const array_default_info = get_schema_class_info(array_with_default);

		// Default shouldn't change the core type
		assert.strictEqual(string_default_info?.type, 'ZodString');
		assert.ok(!string_default_info?.is_array);

		// This is what's failing in the test - default-wrapped arrays should still be identified as arrays
		assert.strictEqual(array_default_info?.type, 'ZodArray');
		assert.ok(array_default_info?.is_array);
	});

	test('handles object schemas', () => {
		const object_schema = z.object({
			name: z.string(),
			count: z.number(),
		});

		const object_info = get_schema_class_info(object_schema);
		assert.strictEqual(object_info?.type, 'ZodObject');
		assert.ok(!object_info?.is_array);
	});

	test('detects class names set with cell_class', () => {
		const schema = z.object({id: z.string()});
		const schema_with_class = schema.meta({cell_class_name: 'TestClass'});

		const info = get_schema_class_info(schema_with_class);
		assert.strictEqual(info?.class_name, 'TestClass');
	});

	test('detects element classes from element metadata', () => {
		const element_schema = z.string().meta({cell_class_name: 'ElementClass'});
		const array_schema = z.array(element_schema);

		const info = get_schema_class_info(array_schema);
		assert.ok(info?.is_array);
		assert.strictEqual(info?.element_class, 'ElementClass');
	});

	test('handles default-wrapped array with element metadata', () => {
		const element_schema = z.string().meta({cell_class_name: 'ElementClass'});
		const array_schema = z.array(element_schema).default([]);

		const info = get_schema_class_info(array_schema);
		assert.ok(info?.is_array);
		assert.strictEqual(info?.element_class, 'ElementClass');
	});

	test('reads element class from nested element schema', () => {
		// Test that metadata on element schema is properly read
		const element_schema = z
			.object({name: z.string()})
			.meta({cell_class_name: 'DirectElementClass'});
		const array_schema = z.array(element_schema);

		// Verify that get_schema_class_info can read element metadata
		const info = get_schema_class_info(array_schema);
		assert.ok(info?.is_array);
		assert.strictEqual(info?.element_class, 'DirectElementClass');
	});

	test('handles ZodDefault containing a ZodArray', () => {
		// Create array schema and wrap in ZodDefault
		const array_schema = z.array(z.string());
		const array_schema_default = array_schema.default([]);

		// We can see what the internal structure of ZodDefault looks like
		assert.isDefined(array_schema_default._zod.def);
		assert.strictEqual(array_schema_default._zod.def.type, 'default');
		assert.isDefined(array_schema_default._zod.def.innerType);
		assert.strictEqual(array_schema_default._zod.def.innerType.def.type, 'array');

		// Now test the function with our default-wrapped array
		const info = get_schema_class_info(array_schema_default);

		// The function should see through the ZodDefault to the ZodArray inside
		assert.strictEqual(info?.type, 'ZodArray');
		assert.ok(info?.is_array);
	});

	test('handles complex nested schema wrapping', () => {
		// Create nested wrapping: ZodDefault -> ZodOptional -> ZodArray
		const nested_array_schema = z.array(z.string()).optional().default([]);

		const nested_info = get_schema_class_info(nested_array_schema);
		assert.strictEqual(nested_info?.type, 'ZodArray');
		assert.ok(nested_info?.is_array);

		// More extreme nesting: ZodDefault -> ZodOptional -> ZodDefault -> ZodArray
		const extreme_nesting = z.array(z.number()).default([]).optional().default([]);

		const extreme_info = get_schema_class_info(extreme_nesting);
		assert.strictEqual(extreme_info?.type, 'ZodArray');
		assert.ok(extreme_info?.is_array);
	});

	test('handles ZodEffects wrapping arrays', () => {
		// ZodEffects (refinement) wrapping an array
		const refined_array = z
			.array(z.string())
			.refine((arr) => arr.length > 0, {message: 'Array must not be empty'});

		const refined_info = get_schema_class_info(refined_array);
		assert.strictEqual(refined_info?.type, 'ZodArray');
		assert.ok(refined_info?.is_array);

		// ZodEffects (transform) wrapping an array with default
		const transformed_array = z
			.array(z.number())
			.default([])
			.transform((arr) => arr.map((n) => n * 2));

		const transformed_info = get_schema_class_info(transformed_array);
		assert.strictEqual(transformed_info?.type, 'ZodArray');
		assert.ok(transformed_info?.is_array);
	});

	test('handles combinations of optional, default, and refinement', () => {
		// Complex chain: optional -> default -> refine -> transform -> array
		const complex_chain = z
			.array(z.string())
			.refine((arr) => arr.every((s) => s.length > 0), {message: 'No empty strings'})
			.transform((arr) => arr.map((s) => s.trim()))
			.default([])
			.optional();

		const chain_info = get_schema_class_info(complex_chain);
		assert.strictEqual(chain_info?.type, 'ZodArray');
		assert.ok(chain_info?.is_array);
	});

	test('recursive unwrapping preserves metadata through wrappers', () => {
		// Create an array with element that has metadata
		const element = z.string().meta({cell_class_name: 'TestElement'});
		const array_with_class = z.array(element);

		// Wrap it multiple times
		const wrapped_array = array_with_class.optional().default([]);

		// Check that metadata is preserved
		const info = get_schema_class_info(wrapped_array);
		assert.strictEqual(info?.element_class, 'TestElement');
		assert.ok(info?.is_array);
	});

	test('handles deeply nested schemas with element metadata', () => {
		// Create a deeply nested schema with element metadata
		const element = z.string().meta({cell_class_name: 'NestedElement'});
		const nested_schema = z.array(element).optional().default([]);

		// Verify metadata is found correctly through the wrappers
		const info = get_schema_class_info(nested_schema);
		assert.ok(info?.is_array);
		assert.strictEqual(info?.element_class, 'NestedElement');
	});
});

describe('cell_class', () => {
	test('adds class name metadata to schemas', () => {
		const schema = z.object({name: z.string()});
		const result = schema.meta({cell_class_name: 'TestCellClass'});

		// Should add the metadata via .meta()
		assert.strictEqual(result.meta()?.cell_class_name, 'TestCellClass');

		// Should return a new schema instance (due to .meta() creating a new instance)
		assert.notStrictEqual(result, schema);

		// Get schema info should report it correctly
		const info = get_schema_class_info(result);
		assert.strictEqual(info?.class_name, 'TestCellClass');
	});
});
