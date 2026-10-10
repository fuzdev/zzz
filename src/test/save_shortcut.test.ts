import { test, describe, assert } from 'vitest';

import { handle_save_shortcut_keydown } from '$lib/save_shortcut.ts';

/** A keydown event stand-in recording what was done to it. */
const create_event = (
	init: Partial<Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat'>> & {
		default_prevented?: boolean;
	}
) => {
	const event = {
		key: init.key ?? 's',
		ctrlKey: init.ctrlKey ?? false,
		metaKey: init.metaKey ?? false,
		altKey: init.altKey ?? false,
		repeat: init.repeat ?? false,
		defaultPrevented: init.default_prevented ?? false,
		prevented: false,
		stopped: false,
		preventDefault() {
			this.prevented = true;
			this.defaultPrevented = true;
		},
		stopImmediatePropagation() {
			this.stopped = true;
		},
		stopPropagation() {
			this.stopped = true;
		}
	};
	return event;
};

const run = (event: ReturnType<typeof create_event>, save: (() => void) | undefined): void => {
	handle_save_shortcut_keydown(event as unknown as KeyboardEvent, save);
};

describe('handle_save_shortcut_keydown', () => {
	test('Ctrl+S and Cmd+S save and swallow, whatever the case', () => {
		for (const init of [
			{ ctrlKey: true },
			{ metaKey: true },
			{ ctrlKey: true, key: 'S' },
			{ metaKey: true, key: 'S' }
		]) {
			let saves = 0;
			const event = create_event(init);
			run(event, () => saves++);
			assert.strictEqual(saves, 1, JSON.stringify(init));
			assert.isTrue(event.prevented);
			assert.isTrue(event.stopped);
		}
	});

	test('a held key saves once, still swallowing each repeat', () => {
		let saves = 0;
		const event = create_event({ ctrlKey: true, repeat: true });
		run(event, () => saves++);
		assert.strictEqual(saves, 0);
		assert.isTrue(event.prevented, 'the repeat still never reaches the browser');
	});

	test('other keys, Alt, and a missing modifier pass through untouched', () => {
		for (const init of [
			{ key: 's' },
			{ ctrlKey: true, key: 'a' },
			{ ctrlKey: true, altKey: true },
			{ metaKey: true, altKey: true }
		]) {
			let saves = 0;
			const event = create_event(init);
			run(event, () => saves++);
			assert.strictEqual(saves, 0, JSON.stringify(init));
			assert.isFalse(event.prevented);
			assert.isFalse(event.stopped);
		}
	});

	test('an event already handled, or no save, passes through untouched', () => {
		let saves = 0;
		const handled = create_event({ ctrlKey: true, default_prevented: true });
		run(handled, () => saves++);
		assert.strictEqual(saves, 0);
		assert.isFalse(handled.stopped);

		const unsaved = create_event({ ctrlKey: true });
		run(unsaved, undefined);
		assert.isFalse(unsaved.prevented, "the browser's own save stays available");
	});
});
