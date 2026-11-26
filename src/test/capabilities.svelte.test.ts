// @vitest-environment jsdom

import { test, describe, beforeEach, assert, vi } from 'vitest';
import { expect_logged_error } from '@fuzdev/fuz_app/testing/logged_errors.ts';

import { Frontend } from '#lib/frontend.svelte.ts';

let app: Frontend;

beforeEach(() => {
	app = new Frontend();
	vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('Capabilities backend ping status', () => {
	test('the first ping shows pending until it answers', () => {
		const { capabilities } = app;
		capabilities.handle_ping_sent('p1');
		assert.strictEqual(capabilities.backend.status, 'pending');
		assert.strictEqual(capabilities.backend_available, null);

		capabilities.handle_ping_received('p1');
		assert.strictEqual(capabilities.backend.status, 'success');
		assert.strictEqual(capabilities.backend_available, true);
	});

	test('a ping once connected keeps the connected status instead of flickering', () => {
		const { capabilities } = app;
		capabilities.handle_ping_sent('p1');
		capabilities.handle_ping_received('p1');

		capabilities.handle_ping_sent('p2');
		assert.strictEqual(capabilities.backend.status, 'success');
		assert.strictEqual(capabilities.backend_available, true);
		assert.strictEqual(capabilities.backend.message_id, 'p2');

		capabilities.handle_ping_received('p2');
		assert.strictEqual(capabilities.backend.status, 'success');
	});

	test('a failed ping once connected shows the failure', () => {
		expect_logged_error('[capabilities] [handle_ping_error] ping_id p2 gone');
		const { capabilities } = app;
		capabilities.handle_ping_sent('p1');
		capabilities.handle_ping_received('p1');

		capabilities.handle_ping_sent('p2');
		capabilities.handle_ping_error('p2', 'gone');
		assert.strictEqual(capabilities.backend.status, 'failure');
		assert.strictEqual(capabilities.backend.error_message, 'gone');

		// not connected anymore, so the next ping shows pending again
		capabilities.handle_ping_sent('p3');
		assert.strictEqual(capabilities.backend.status, 'pending');
	});
});
