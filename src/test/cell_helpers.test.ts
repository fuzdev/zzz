import {
	array,
	boolean,
	check,
	nullable,
	number,
	optional,
	pipe,
	string,
	strip_object,
	transform,
	with_default,
	with_default_fn
} from '@fuzdev/fuz_schema/schema.ts';
import { get_meta, meta } from '@fuzdev/fuz_schema/meta.ts';
import { describe, test, assert } from 'vitest';

import { create_collection_decoder, get_schema_class_info, HANDLED } from '#lib/cell_helpers.ts';

describe('get_schema_class_info', () => {
	test('handles null or undefined schemas', () => {
		assert.isNull(get_schema_class_info(null));
		assert.isNull(get_schema_class_info(undefined));
	});

	test('identifies basic schema kinds correctly', () => {
		const string_info = get_schema_class_info(string);
		const number_info = get_schema_class_info(number);
		const boolean_info = get_schema_class_info(boolean);

		assert.strictEqual(string_info?.kind, 'string');
		assert.ok(!string_info?.is_array);

		assert.strictEqual(number_info?.kind, 'number');
		assert.ok(!number_info?.is_array);

		assert.strictEqual(boolean_info?.kind, 'boolean');
		assert.ok(!boolean_info?.is_array);
	});

	test('identifies array schemas correctly', () => {
		const string_array_info = get_schema_class_info(array(string));
		const number_array_info = get_schema_class_info(array(number));
		const object_array_info = get_schema_class_info(array(strip_object({ name: string })));

		assert.strictEqual(string_array_info?.kind, 'array');
		assert.ok(string_array_info?.is_array);

		assert.strictEqual(number_array_info?.kind, 'array');
		assert.ok(number_array_info?.is_array);

		assert.strictEqual(object_array_info?.kind, 'array');
		assert.ok(object_array_info?.is_array);
	});

	test('handles default wrapped schemas', () => {
		const string_default_info = get_schema_class_info(with_default(string, 'default'));
		const array_default_info = get_schema_class_info(with_default_fn(array(string), () => []));

		// a default doesn't change the core kind
		assert.strictEqual(string_default_info?.kind, 'string');
		assert.ok(!string_default_info?.is_array);

		// default-wrapped arrays are still arrays
		assert.strictEqual(array_default_info?.kind, 'array');
		assert.ok(array_default_info?.is_array);
	});

	test('handles object schemas', () => {
		const object_info = get_schema_class_info(strip_object({ name: string, count: number }));
		assert.strictEqual(object_info?.kind, 'strip_object');
		assert.ok(!object_info?.is_array);
	});

	test('detects class names set with cell_class_name', () => {
		const schema_with_class = meta(strip_object({ id: string }), { cell_class_name: 'TestClass' });

		const info = get_schema_class_info(schema_with_class);
		assert.strictEqual(info?.class_name, 'TestClass');
		assert.strictEqual(info?.kind, 'strip_object');
		assert.ok(!info?.is_array);
	});

	test('detects class names under wrappers, the outermost first', () => {
		const inner = meta(strip_object({ id: string }), { cell_class_name: 'Inner' });

		assert.strictEqual(
			get_schema_class_info(with_default_fn(nullable(inner), () => null))?.class_name,
			'Inner'
		);
		assert.strictEqual(
			get_schema_class_info(meta(optional(inner), { cell_class_name: 'Outer' }))?.class_name,
			'Outer'
		);
	});

	test('detects element classes from element metadata', () => {
		const element_schema = meta(string, { cell_class_name: 'ElementClass' });

		const info = get_schema_class_info(array(element_schema));
		assert.ok(info?.is_array);
		assert.strictEqual(info.element_class, 'ElementClass');
		assert.isUndefined(info.class_name);
	});

	test('handles default-wrapped array with element metadata', () => {
		const element_schema = meta(string, { cell_class_name: 'ElementClass' });

		const info = get_schema_class_info(with_default_fn(array(element_schema), () => []));
		assert.ok(info?.is_array);
		assert.strictEqual(info.element_class, 'ElementClass');
	});

	test('reads element class from nested element schema', () => {
		const element_schema = meta(strip_object({ name: string }), {
			cell_class_name: 'DirectElementClass'
		});

		const info = get_schema_class_info(array(element_schema));
		assert.ok(info?.is_array);
		assert.strictEqual(info.element_class, 'DirectElementClass');
	});

	test('reads element class under the element wrappers', () => {
		const element_schema = meta(strip_object({ name: string }), { cell_class_name: 'Wrapped' });

		const info = get_schema_class_info(array(optional(element_schema)));
		assert.ok(info?.is_array);
		assert.strictEqual(info.element_class, 'Wrapped');
	});

	test('handles complex nested schema wrapping', () => {
		const nested_info = get_schema_class_info(with_default_fn(optional(array(string)), () => []));
		assert.strictEqual(nested_info?.kind, 'array');
		assert.ok(nested_info?.is_array);

		const extreme_nesting = with_default_fn(
			optional(with_default_fn(array(number), () => [])),
			() => []
		);

		const extreme_info = get_schema_class_info(extreme_nesting);
		assert.strictEqual(extreme_info?.kind, 'array');
		assert.ok(extreme_info?.is_array);
	});

	test('handles pipes starting with arrays', () => {
		const refined_array = pipe(
			array(string),
			check((arr: Array<string>) => arr.length > 0, 'a non-empty array')
		);

		const refined_info = get_schema_class_info(refined_array);
		assert.strictEqual(refined_info?.kind, 'array');
		assert.ok(refined_info?.is_array);

		const transformed_array = pipe(
			with_default_fn(array(number), () => []),
			transform((arr: Array<number>) => arr.map((n) => n * 2))
		);

		const transformed_info = get_schema_class_info(transformed_array);
		assert.strictEqual(transformed_info?.kind, 'array');
		assert.ok(transformed_info?.is_array);
	});

	test('handles combinations of optional, default, and refinement', () => {
		const complex_chain = with_default_fn(
			optional(
				pipe(
					array(string),
					check((arr: Array<string>) => arr.every((s) => s.length > 0), 'no empty strings'),
					transform((arr: Array<string>) => arr.map((s) => s.trim()))
				)
			),
			() => []
		);

		const chain_info = get_schema_class_info(complex_chain);
		assert.strictEqual(chain_info?.kind, 'array');
		assert.ok(chain_info?.is_array);
	});

	test('recursive unwrapping preserves metadata through wrappers', () => {
		const element = meta(string, { cell_class_name: 'TestElement' });
		const wrapped_array = with_default_fn(optional(array(element)), () => []);

		const info = get_schema_class_info(wrapped_array);
		assert.strictEqual(info?.element_class, 'TestElement');
		assert.ok(info?.is_array);
	});

	test('handles deeply nested schemas with element metadata', () => {
		const element = meta(string, { cell_class_name: 'NestedElement' });
		const nested_schema = with_default_fn(array(element), () => []);

		const info = get_schema_class_info(nested_schema);
		assert.ok(info?.is_array);
		assert.strictEqual(info.element_class, 'NestedElement');
	});
});

describe('cell_class_name', () => {
	test('adds class name metadata to schemas', () => {
		const schema = strip_object({ name: string });
		const result = meta(schema, { cell_class_name: 'TestCellClass' });

		assert.strictEqual(get_meta(result)?.cell_class_name, 'TestCellClass');

		// `meta` returns a copy and leaves the schema given alone
		assert.notStrictEqual(result, schema);
		assert.isUndefined(get_meta(schema));

		const info = get_schema_class_info(result);
		assert.strictEqual(info?.class_name, 'TestCellClass');
	});
});

describe('create_collection_decoder', () => {
	const create_log_decoder = () => {
		const log: Array<string> = [];
		const decode = create_collection_decoder(
			() => log.push('clear'),
			(json: { name: string }) => log.push('add ' + json.name)
		);
		return { log, decode };
	};

	test('an array clears, then adds each element in order', () => {
		const { log, decode } = create_log_decoder();
		assert.strictEqual(decode([{ name: 'a' }, { name: 'b' }]), HANDLED);
		assert.deepEqual(log, ['clear', 'add a', 'add b']);
	});

	test('an empty array clears', () => {
		const { log, decode } = create_log_decoder();
		assert.strictEqual(decode([]), HANDLED);
		assert.deepEqual(log, ['clear']);
	});

	test('a non-array value leaves the collection unchanged but is still handled', () => {
		const { log, decode } = create_log_decoder();
		for (const value of [undefined, null, 'a', 1, { name: 'a' }]) {
			assert.strictEqual(decode(value), HANDLED);
		}
		assert.deepEqual(log, []);
	});
});
