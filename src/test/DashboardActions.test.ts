// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import DashboardActions from '#lib/DashboardActions.svelte';
import { Frontend } from '#lib/frontend.svelte.ts';
import { sidebar_toggle_action_spec } from '#lib/action_specs.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests, to_visible_text } from './test_helpers.ts';

/**
 * The actions page: the wire log, then the recent intents under it, one
 * selection across both, the selected entry's whole record in the panel.
 */

let app: Frontend;
const cleanups: Array<() => void> = [];

// jsdom has no Web Animations, which the wire log's transitions use
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
	for (const cleanup of cleanups.splice(0)) cleanup();
	app.dispose();
	if (animate_original) {
		Element.prototype.animate = animate_original;
	} else {
		delete (Element.prototype as Partial<Element>).animate;
	}
});

const render = (): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: DashboardActions, props: {} }
	});
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
		flushSync();
	});
	return target;
};

/** The section of the recent intents, under the wire log. */
const intents_section = (target: HTMLElement): HTMLElement => {
	const heading = [...target.querySelectorAll('h2')].find(
		(h) => h.textContent.trim() === 'recent intents'
	);
	assert.ok(heading);
	const section = heading.closest('section');
	assert.ok(section);
	return section;
};

const intent_rows = (target: HTMLElement): Array<HTMLButtonElement> => [
	...intents_section(target).querySelectorAll<HTMLButtonElement>('ol button')
];

const clear_button = (target: HTMLElement): HTMLButtonElement => {
	const button = [...intents_section(target).querySelectorAll('button')].find(
		(b) => b.textContent.trim() === 'clear'
	);
	assert.ok(button);
	return button;
};

/** The detail panel's text. */
const panel_text = (target: HTMLElement): string => {
	const panel = target.querySelector<HTMLElement>('.panel');
	assert.ok(panel);
	return to_visible_text(panel);
};

describe('DashboardActions', () => {
	test('the wire log comes first, the recent intents under it', () => {
		const target = render();
		const headings = [...target.querySelectorAll('h2')].map((h) => h.textContent.trim());
		assert.deepEqual(headings, ['wire log', 'recent intents']);
	});

	test('an intent row is its method and time, newest first, and selecting it shows the entry', () => {
		app.intents.sidebar_toggle();
		app.intents.desk_toggle({ show: false });
		const target = render();
		const rows = intent_rows(target);
		assert.strictEqual(rows.length, 2);
		assert.include(rows[0]!.textContent, 'desk_toggle');
		assert.include(rows[1]!.textContent, 'sidebar_toggle');
		// no version, history, or input on the row
		assert.notInclude(rows[0]!.textContent, 'v1');
		assert.notInclude(rows[0]!.textContent, 'show');

		rows[0]!.click();
		flushSync();
		assert.ok(rows[0]!.classList.contains('selected'));
		const text = panel_text(target);
		assert.include(text, 'desk_toggle');
		assert.include(text, '"show": false');
		assert.include(text, 'applied');
	});

	test('a failed intent shows its error', () => {
		app.recent_intents.record(sidebar_toggle_action_spec, { show: true }, 'failed', 'it broke');
		const target = render();
		const [row] = intent_rows(target);
		assert.ok(row);
		assert.strictEqual(row.title, 'it broke');
		row.click();
		flushSync();
		const text = panel_text(target);
		assert.include(text, 'failed');
		assert.include(text, 'it broke');
	});

	test('one selection across the wire log and the intents; clearing the intents deselects', () => {
		const action = app.actions.add_from_json({ method: 'ping' });
		app.intents.sidebar_toggle();
		const target = render();
		// the row's method span, not the page's own "ping" button
		const wire_row = [...target.querySelectorAll('span.ellipsis')]
			.find((span) => span.textContent === 'ping' && !intents_section(target).contains(span))
			?.closest('button');
		assert.ok(wire_row);

		wire_row.click();
		flushSync();
		assert.include(panel_text(target), action.id);

		intent_rows(target)[0]!.click();
		flushSync();
		assert.include(panel_text(target), 'sidebar_toggle');
		assert.notInclude(panel_text(target), action.id);
		assert.isFalse(wire_row.classList.contains('selected'));

		// clearing the selected intent leaves nothing selected — not the earlier wire action
		clear_button(target).click();
		flushSync();
		assert.notInclude(panel_text(target), 'sidebar_toggle');
		assert.notInclude(panel_text(target), action.id);
		assert.include(panel_text(target), 'select an action');
	});
});
