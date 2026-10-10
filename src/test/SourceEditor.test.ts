// @vitest-environment jsdom

import { describe, test, assert, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import SourceEditor from '$lib/SourceEditor.svelte';

import { create_reactive_props } from './reactive_test_helpers.svelte.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const render = (props: Record<string, unknown>) => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(SourceEditor, { target, props: props as any });
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
	});
	const textarea = target.querySelector('textarea');
	assert.ok(textarea, 'renders a textarea');
	return { target, textarea, mounted };
};

const type_into = (textarea: HTMLTextAreaElement, value: string): void => {
	textarea.value = value;
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

const press_save = (target: EventTarget): KeyboardEvent => {
	const event = new KeyboardEvent('keydown', {
		key: 's',
		ctrlKey: true,
		bubbles: true,
		cancelable: true
	});
	target.dispatchEvent(event);
	return event;
};

describe('SourceEditor', () => {
	test('renders the value highlighted as its lang, readonly when asked', () => {
		const { target, textarea } = render({ value: '# hi', lang: 'md', readonly: true });
		assert.strictEqual(textarea.value, '# hi');
		assert.isTrue(textarea.readOnly);
		assert.strictEqual(target.querySelector('.code_textarea')?.getAttribute('data-lang'), 'md');
	});

	test('Ctrl+S in the textarea saves the typed value', () => {
		const saved: Array<string> = [];
		const { textarea } = render({ value: 'a', onsave: (v: string) => saved.push(v) });
		type_into(textarea, 'ab');
		const event = press_save(textarea);
		assert.deepEqual(saved, ['ab']);
		assert.isTrue(event.defaultPrevented);
	});

	test("'focused' ignores Ctrl+S elsewhere on the page, 'page' takes it", () => {
		const saved: Array<string> = [];
		render({ value: 'focused', onsave: (v: string) => saved.push(v) });
		press_save(document.body);
		assert.deepEqual(saved, []);

		render({ value: 'page', onsave: (v: string) => saved.push(v), save_shortcut: 'page' });
		press_save(document.body);
		assert.deepEqual(saved, ['page']);
	});

	test('a pending focus key equal to its own focuses the textarea', () => {
		const props = create_reactive_props<Record<string, unknown>>({
			value: '',
			focus_key: 'k',
			pending_element_to_focus_key: null
		});
		const { textarea } = render(props);
		assert.notStrictEqual(document.activeElement, textarea);
		props.pending_element_to_focus_key = 'other';
		flushSync();
		assert.notStrictEqual(document.activeElement, textarea);
		props.pending_element_to_focus_key = 'k';
		flushSync();
		assert.strictEqual(document.activeElement, textarea);
	});

	test('`focus` focuses the textarea', () => {
		const { textarea, mounted } = render({ value: '' });
		(mounted as unknown as { focus: () => void }).focus();
		assert.strictEqual(document.activeElement, textarea);
	});
});
