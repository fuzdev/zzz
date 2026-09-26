// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import PartView from '$lib/PartView.svelte';
import TurnView from '$lib/TurnView.svelte';
import { Frontend } from '$lib/frontend.svelte.ts';
import { Part } from '$lib/part.svelte.ts';
import { Thread } from '$lib/thread.svelte.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

let app: Frontend;
let cleanup: (() => void) | null = null;

// jsdom has no Web Animations, which Svelte transitions (the confirm popover's) use
const animate_original = Element.prototype.animate as Element['animate'] | undefined;
const animate_stub = function (this: Element): Animation {
	const animation = {
		onfinish: null as (() => void) | null,
		cancel: () => {},
		finished: Promise.resolve()
	};
	queueMicrotask(() => animation.onfinish?.());
	return animation as unknown as Animation;
};

beforeEach(() => {
	Element.prototype.animate = animate_stub;
	app = monkeypatch_zzz_for_tests(new Frontend());
});
afterEach(() => {
	cleanup?.();
	cleanup = null;
	if (animate_original) {
		Element.prototype.animate = animate_original;
	} else {
		delete (Element.prototype as Partial<Element>).animate;
	}
});

const render = (component: Component<any>, props: Record<string, unknown>): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, { target, props: { app, component, props } });
	flushSync();
	cleanup = () => {
		void unmount(mounted);
		target.remove();
	};
	return target;
};

const find_remove_button = (target: HTMLElement): HTMLButtonElement | null =>
	target.querySelector('button[title^="remove part"]');

/** Clicks the remove button, then the confirm button its popover opens. */
const remove_part = (target: HTMLElement): void => {
	const trigger = find_remove_button(target);
	assert.ok(trigger);
	const before = new Set(target.querySelectorAll('button'));
	trigger.click();
	flushSync();
	const confirm = Array.from(target.querySelectorAll('button')).find((b) => !before.has(b));
	assert.ok(confirm, 'the popover opens a confirm button');
	confirm.click();
	flushSync();
};

describe('part remove controls', () => {
	test('remove a prompt part through its prompt, not the selected one', () => {
		const prompt = app.prompts.add();
		const part = prompt.add_part(Part.create(app, { type: 'text', content: 'x' }));
		const other = app.prompts.add();
		app.prompts.selected_id = other.id;

		const target = render(PartView, { part, owner: prompt });
		remove_part(target);

		assert.strictEqual(prompt.parts.length, 0);
	});

	test('remove a turn part from the turn and from `app.parts`', () => {
		const thread = app.threads.add_thread(new Thread({ app, json: { model_name: 'm' } }));
		const turn = thread.add_user_turn('hello');
		const [part_id] = turn.part_ids;

		const target = render(TurnView, { turn });
		remove_part(target);

		assert.deepEqual(turn.part_ids, []);
		assert.ok(!app.parts.items.has(part_id!));
	});

	test('no remove control without an owner', () => {
		const part = app.parts.add({ type: 'text', content: 'x' });
		const target = render(PartView, { part });
		assert.strictEqual(find_remove_button(target), null);
	});
});
