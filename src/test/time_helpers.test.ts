import { test, describe, assert } from 'vitest';

import { format_ms_to_readable } from '$lib/time_helpers.ts';

describe('format_ms_to_readable', () => {
	test('reads naturally', () => {
		assert.strictEqual(format_ms_to_readable(500), '500ms');
		assert.strictEqual(format_ms_to_readable(1_000), '1 second');
		assert.strictEqual(format_ms_to_readable(1_500), '1.5 seconds');
		assert.strictEqual(format_ms_to_readable(1_234), '1.2 seconds');
		assert.strictEqual(format_ms_to_readable(30_000), '30 seconds');
	});
});
