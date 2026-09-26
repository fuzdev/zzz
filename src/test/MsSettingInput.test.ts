// @vitest-environment jsdom

import { describe, test, assert, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import MsSettingInput from '$lib/MsSettingInput.svelte';
import { Frontend } from '$lib/frontend.svelte.ts';
import { HEARTBEAT_INTERVAL_BOUNDS } from '$lib/socket_helpers.ts';

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

/** Mount the heartbeat setting the way `CapabilityWebsocket` does. */
const mount_heartbeat = () => {
	const { socket } = new Frontend();
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(MsSettingInput, {
		target,
		props: {
			get value() {
				return socket.heartbeat_interval;
			},
			label: 'heartbeat interval',
			bounds: HEARTBEAT_INTERVAL_BOUNDS,
			step: 1000,
			onvalue: (v: number) => (socket.heartbeat_interval = v)
		}
	});
	flushSync();
	cleanup = () => {
		void unmount(component);
		target.remove();
	};
	const [range, field] = Array.from(target.querySelectorAll('input'));
	return { socket, range: range!, field: field! };
};

const type = (input: HTMLInputElement, value: string): void => {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

const commit = (input: HTMLInputElement): void => {
	input.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
};

describe('MsSettingInput', () => {
	test('typing does not touch the setting or the field until commit', () => {
		const { socket, field } = mount_heartbeat();
		const initial = socket.heartbeat_interval;

		type(field, '');
		assert.strictEqual(field.value, '');
		type(field, '4');
		type(field, '45');
		type(field, '45000');
		assert.strictEqual(field.value, '45000');
		assert.strictEqual(socket.heartbeat_interval, initial);

		commit(field);
		assert.strictEqual(socket.heartbeat_interval, 45_000);
		assert.strictEqual(field.value, '45000');
	});

	test('a committed out-of-range value shows the clamped setting', () => {
		const { socket, field } = mount_heartbeat();
		type(field, '4');
		commit(field);
		assert.strictEqual(socket.heartbeat_interval, HEARTBEAT_INTERVAL_BOUNDS.min);
		assert.strictEqual(field.value, String(HEARTBEAT_INTERVAL_BOUNDS.min));
	});

	test('a committed empty field keeps and shows the current setting', () => {
		const { socket, field } = mount_heartbeat();
		const initial = socket.heartbeat_interval;
		type(field, '');
		commit(field);
		assert.strictEqual(socket.heartbeat_interval, initial);
		assert.strictEqual(field.value, String(initial));
	});

	test('the slider has an accessible name', () => {
		const { range } = mount_heartbeat();
		assert.strictEqual(range.getAttribute('aria-label'), 'heartbeat interval');
	});

	test('the slider commits as it moves and the field follows', () => {
		const { socket, range, field } = mount_heartbeat();
		type(range, '120000');
		assert.strictEqual(socket.heartbeat_interval, 120_000);
		assert.strictEqual(field.value, '120000');
	});
});
