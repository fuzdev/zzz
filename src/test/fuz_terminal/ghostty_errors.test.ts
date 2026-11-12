import { test, describe, assert } from 'vitest';

import { to_thrown_message } from '#lib/fuz_terminal/ghostty_errors.ts';

/** An `Error` whose `message` is `message`, whatever its type. */
const error_with_message = (message: unknown): Error => {
	const error = new Error();
	Object.defineProperty(error, 'message', { value: message });
	return error;
};

describe('to_thrown_message', () => {
	test("an error's message", () => {
		assert.strictEqual(to_thrown_message(new Error('boom')), 'boom');
	});

	test('a value that is not an error, coerced', () => {
		assert.strictEqual(to_thrown_message('plain'), 'plain');
		assert.strictEqual(to_thrown_message(42), '42');
		assert.strictEqual(to_thrown_message(undefined), 'undefined');
	});

	test("an error's message that is not a string, coerced", () => {
		assert.strictEqual(to_thrown_message(error_with_message(42)), '42');
		assert.strictEqual(to_thrown_message(error_with_message(Symbol('odd'))), 'Symbol(odd)');
		assert.strictEqual(to_thrown_message(error_with_message({ toString: () => 'shown' })), 'shown');
	});

	test('a value with no usable message', () => {
		const unprintable = {
			toString: () => {
				throw new Error('no string');
			}
		};
		assert.strictEqual(
			to_thrown_message(error_with_message(unprintable)),
			'a value that has no message'
		);
		assert.strictEqual(to_thrown_message(Object.create(null)), 'a value that has no message');
		const throwing_getter = new Error();
		Object.defineProperty(throwing_getter, 'message', {
			get: () => {
				throw new Error('no message');
			}
		});
		assert.strictEqual(to_thrown_message(throwing_getter), 'a value that has no message');
	});
});
