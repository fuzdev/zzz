// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { describe, test, assert, afterEach, beforeEach, vi } from 'vitest';
import { wait } from '@fuzdev/fuz_util/async.ts';
import { createRawSnippet, flushSync, mount, unmount, type Component } from 'svelte';

import DiskfileDetailsDrawer from '#lib/DiskfileDetailsDrawer.svelte';
import DiskfileAudioView from '#lib/DiskfileAudioView.svelte';
import DiskfileEditorView from '#lib/DiskfileEditorView.svelte';
import DiskfileMarkdownView from '#lib/DiskfileMarkdownView.svelte';
import DiskfileTranscriptView from '#lib/DiskfileTranscriptView.svelte';
import { Frontend } from '#lib/frontend.svelte.ts';
import type { Diskfile } from '#lib/diskfile.svelte.ts';
import { SerializableDisknode } from '#lib/diskfile_types.ts';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { install_fake_disk, type FakeDisk } from './diskfile_test_helpers.ts';

/**
 * Every file view's details sit in one drawer, which follows the app-wide
 * `Ui.show_diskfile_details`: it takes its width in the flow at once, and its
 * content slides in and out, inert while closing.
 */

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

let app: Frontend;
let disk: FakeDisk;
const cleanups: Array<() => void> = [];

// jsdom has no Web Animations, which Svelte transitions use
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
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	disk = install_fake_disk(app, SOURCE_DIR);
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	if (animate_original) {
		Element.prototype.animate = animate_original;
	} else {
		delete (Element.prototype as Partial<Element>).animate;
	}
});

const write_file = (path: string, contents: string | null): Promise<Diskfile> =>
	disk.load(path, contents);

const render = (component: Component<any>, props: Record<string, unknown>) => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, { target, props: { app, component, props } });
	flushSync();
	let destroyed = false;
	const destroy = (): void => {
		if (destroyed) return;
		destroyed = true;
		void unmount(mounted);
		target.remove();
		flushSync();
	};
	cleanups.push(destroy);
	return { target, destroy };
};

const render_drawer = () =>
	render(DiskfileDetailsDrawer, {
		children: createRawSnippet(() => ({ render: () => '<div><h4>the details</h4></div>' }))
	});

/** Toggles the setting, as the files header's button does. */
const toggle = (): void => {
	app.ui.toggle_diskfile_details();
	flushSync();
};

const drawer = (target: HTMLElement): HTMLElement => {
	const el = target.querySelector<HTMLElement>('.details-drawer');
	assert.ok(el);
	return el;
};
/** Whether the wrapper takes the drawer's width in the flow. */
const in_flow = (target: HTMLElement): boolean => drawer(target).classList.contains('open');
const content = (target: HTMLElement): HTMLElement | null =>
	target.querySelector<HTMLElement>('.details-drawer-content');
const panel = (target: HTMLElement): HTMLElement => {
	const el = target.querySelector<HTMLElement>('.details-drawer-panel');
	assert.ok(el);
	return el;
};

/** Gives the drawer's panel a transition, as a browser with motion allowed computes it. */
const allow_motion = (): void => {
	const original = window.getComputedStyle.bind(window);
	vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
		el.classList.contains('details-drawer-panel')
			? ({ transitionDuration: '0.2s' } as CSSStyleDeclaration)
			: original(el, pseudo)
	);
};

const end_transition = (el: Element, property_name = 'transform', type = 'transitionend'): void => {
	const event = new Event(type, { bubbles: true });
	Object.defineProperty(event, 'propertyName', { value: property_name });
	el.dispatchEvent(event);
	flushSync();
};

/**
 * Records each layout read of the panel, which styles it where it is, and
 * whether the wrapper was open then - so a read with it closed means the
 * panel starts off the drawer's edge and slides in.
 */
const watch_panel_reads = (): Array<boolean> => {
	const reads: Array<boolean> = [];
	const original = Element.prototype.getBoundingClientRect;
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
		if (this.classList.contains('details-drawer-panel')) {
			reads.push(!!this.closest('.details-drawer.open'));
		}
		return original.call(this);
	});
	return reads;
};

describe('DiskfileDetailsDrawer', () => {
	test('opens at once on first render, with nothing to animate', () => {
		const reads = watch_panel_reads();
		const view = render_drawer();
		assert.isTrue(in_flow(view.target));
		const shown = content(view.target);
		assert.ok(shown);
		assert.isFalse(shown.inert);
		assert.include(shown.textContent, 'the details');
		assert.deepEqual(reads, [], 'mounted in place, never styled off the edge');
	});

	test('opening takes the flow at once, and the content, mounted off the edge, slides in', () => {
		allow_motion();
		const view = render_drawer();
		toggle();
		end_transition(panel(view.target));
		assert.isNull(content(view.target), 'closed');

		const reads = watch_panel_reads();
		toggle();
		assert.isTrue(in_flow(view.target), 'the panes resize at once');
		assert.deepEqual(reads, [false], 'styled off the edge before the drawer opened');
		const shown = content(view.target);
		assert.ok(shown);
		assert.isFalse(shown.inert, 'usable as it slides in');

		end_transition(panel(view.target));
		assert.ok(content(view.target), 'the end of the open changes nothing');
		assert.deepEqual(reads, [false]);
	});

	test('closing leaves the flow at once, and the content stays, inert, until its own slide ends', () => {
		allow_motion();
		const view = render_drawer();

		toggle();
		assert.isFalse(in_flow(view.target), 'the panes widen at once');
		const closing = content(view.target);
		assert.ok(closing, 'the content stays as it slides out');
		assert.isTrue(closing.inert, 'out of the tab order and the accessibility tree');

		// only the panel's own transform ends it
		const inner = panel(view.target).querySelector('h4');
		assert.ok(inner);
		end_transition(inner);
		end_transition(panel(view.target), 'opacity');
		end_transition(closing);
		end_transition(drawer(view.target));
		end_transition(drawer(view.target), 'width');
		assert.ok(content(view.target), "only the panel's own transform");

		end_transition(panel(view.target));
		assert.isNull(content(view.target), 'closed');
		assert.isFalse(in_flow(view.target));
	});

	test('reopening mid-close keeps the content, usable at once, sliding back from where it is', () => {
		allow_motion();
		const view = render_drawer();
		const original = panel(view.target);
		toggle();

		const reads = watch_panel_reads();
		toggle();
		assert.isTrue(in_flow(view.target));
		assert.strictEqual(panel(view.target), original, 'not remounted');
		assert.deepEqual(reads, [], 'not restarted off the edge');
		const shown = content(view.target);
		assert.ok(shown);
		assert.isFalse(shown.inert);

		// the close's slide is cancelled, unheard, and the open's own ends with the drawer open
		end_transition(panel(view.target));
		assert.ok(content(view.target));
	});

	test("closing during the open's slide keeps the content for the close's own", () => {
		allow_motion();
		const view = render_drawer();
		toggle();
		end_transition(panel(view.target));
		assert.isNull(content(view.target), 'closed');

		toggle();
		toggle();
		assert.isFalse(in_flow(view.target));
		// the browser cancels the open's slide as the close's starts
		end_transition(panel(view.target), 'transform', 'transitioncancel');
		const closing = content(view.target);
		assert.ok(closing, 'still sliding out');
		assert.isTrue(closing.inert);

		end_transition(panel(view.target));
		assert.isNull(content(view.target), 'closed');
	});

	test('with no motion, closing hides the content at once, and opening shows it', () => {
		const view = render_drawer();
		toggle();
		assert.isFalse(in_flow(view.target));
		assert.isNull(content(view.target));

		const reads = watch_panel_reads();
		toggle();
		assert.isTrue(in_flow(view.target));
		const shown = content(view.target);
		assert.ok(shown);
		assert.isFalse(shown.inert);
		assert.deepEqual(reads, [false], 'still styled off the edge first');
	});

	test('a closed drawer stays closed across remounts, with nothing to animate', () => {
		const first = render_drawer();
		toggle();
		first.destroy();
		assert.isFalse(app.ui.show_diskfile_details);

		const reads = watch_panel_reads();
		const second = render_drawer();
		assert.isFalse(in_flow(second.target));
		assert.isNull(content(second.target));
		assert.deepEqual(reads, []);
	});

	test('the setting changed while unmounted applies on the next mount, unanimated', () => {
		const first = render_drawer();
		first.destroy();
		app.ui.show_diskfile_details = false;
		const second = render_drawer();
		assert.isNull(content(second.target));

		second.destroy();
		app.ui.show_diskfile_details = true;
		const reads = watch_panel_reads();
		const third = render_drawer();
		assert.isTrue(in_flow(third.target));
		assert.ok(content(third.target));
		assert.deepEqual(reads, []);
	});
});

const TRANSCRIPT = JSON.stringify({
	version: 2,
	source: { blake3: `blake3:${'ab'.repeat(32)}`, size: 1, duration_ms: 1 },
	tool: {
		backend: 'whisper.cpp',
		version: null,
		model: 'base-en',
		model_blake3: `blake3:${'cd'.repeat(32)}`,
		params: { language: 'en' }
	},
	language: 'en',
	segments: []
});

/** Lets a closing drawer's or a notice's outro finish. */
const settle = async (): Promise<void> => {
	await wait();
	flushSync();
};

const count_text = (target: HTMLElement, text: string): number =>
	target.textContent.split(text).length - 1;

describe('every file view keeps its details in the drawer', () => {
	const cases: Array<{
		name: string;
		component: Component<any>;
		path: string;
		contents: string | null;
		/** Text only the view's details show. */
		details: string;
	}> = [
		{
			name: 'DiskfileEditorView',
			component: DiskfileEditorView,
			path: '/w/a.txt',
			contents: 'hello',
			details: 'save changes'
		},
		{
			name: 'DiskfileMarkdownView',
			component: DiskfileMarkdownView,
			path: '/w/a.md',
			contents: '# A\n',
			details: 'save changes'
		},
		{
			name: 'DiskfileAudioView',
			component: DiskfileAudioView,
			path: '/w/a.webm',
			contents: null,
			details: 'finalize'
		},
		{
			name: 'DiskfileTranscriptView',
			component: DiskfileTranscriptView,
			path: '/w/a.webm.base-en.transcript.json',
			contents: TRANSCRIPT,
			details: 'read-only — a transcript is tool output'
		}
	];

	for (const { name, component, path, contents, details } of cases) {
		test(`${name} renders its details inside the drawer, and closed, not at all`, async () => {
			const diskfile = await write_file(path, contents);
			const view = render(component, { diskfile });
			const shown = content(view.target);
			assert.ok(shown, 'open by default');
			assert.include(shown.textContent, details);
			assert.ok(
				view.target.querySelector('.isolation\\:isolate .details-drawer'),
				"the view's root is a stacking context"
			);

			toggle();
			assert.isNull(content(view.target));
			assert.notInclude(view.target.textContent, details);
		});

		// delete is the first action in the editors' drawers when a file isn't loaded, so their
		// confirmation opens right, into the panel; the audio and transcript rows always have a
		// button before delete, so `ConfirmButton`'s default, `left`, opens over it, inside the
		// panel - `right` would push it past the panel's edge on a full row (the transcript's, with
		// "open audio")
		const opens_right = name === 'DiskfileEditorView' || name === 'DiskfileMarkdownView';
		test(`${name}'s delete confirmation opens inside the drawer, ${opens_right ? 'right' : 'left'}`, async () => {
			const diskfile = await write_file(path, contents);
			const view = render(component, { diskfile });
			const drawer_content = content(view.target);
			assert.ok(drawer_content);
			const trigger = drawer_content.querySelector<HTMLButtonElement>('button[title^="delete"]');
			assert.ok(trigger);
			trigger.click();
			flushSync();
			const confirm = drawer_content.querySelector<HTMLButtonElement>(
				'button[title^="confirm delete"]'
			);
			assert.ok(confirm, 'the confirmation shows');
			const popover = confirm.parentElement;
			assert.ok(popover);
			if (opens_right) {
				assert.strictEqual(popover.style.left, '100%');
				assert.strictEqual(popover.style.right, 'auto');
			} else {
				assert.strictEqual(popover.style.right, '100%');
				assert.strictEqual(popover.style.left, 'auto');
			}
		});
	}
});

describe('a file view shows what its drawer would, with the drawer closed', () => {
	const editor_cases: Array<{
		name: string;
		component: Component<any>;
		path: string;
		contents: string | null;
	}> = [
		{ name: 'DiskfileEditorView', component: DiskfileEditorView, path: '/w/a.txt', contents: 'hi' },
		{
			name: 'DiskfileMarkdownView',
			component: DiskfileMarkdownView,
			path: '/w/a.md',
			contents: '# A\n'
		},
		{
			name: "DiskfileTranscriptView's text editor, for a file that isn't a transcript",
			component: DiskfileTranscriptView,
			path: '/w/a.webm.base-en.transcript.json',
			contents: 'not a transcript'
		}
	];

	for (const { name, component, path, contents } of editor_cases) {
		test(`${name} shows a save error once, with the drawer open or closed`, async () => {
			const diskfile = await write_file(path, contents);
			const view = render(component, { diskfile });
			app.diskfiles.get_editor_state(diskfile).save_error = 'disk full';
			flushSync();
			const count = (): number => count_text(view.target, 'save failed: disk full');
			assert.strictEqual(count(), 1, 'in the drawer');
			assert.ok(content(view.target)?.textContent.includes('save failed: disk full'));

			toggle();
			await settle();
			assert.isNull(content(view.target));
			assert.strictEqual(count(), 1, 'beside the editor');

			toggle();
			await settle();
			assert.strictEqual(count(), 1, 'in the drawer again');
		});
	}

	test('DiskfileTranscriptView shows a failed copy once, with the drawer open or closed', async () => {
		const diskfile = await write_file('/w/a.webm.base-en.transcript.json', TRANSCRIPT);
		vi.spyOn(app.diskfiles, 'create_file_at').mockRejectedValue(new Error('disk full'));
		const view = render(DiskfileTranscriptView, { diskfile });
		const button = Array.from(view.target.querySelectorAll('button')).find(
			(b) => b.textContent.trim() === 'edit a copy'
		);
		assert.ok(button);
		button.click();
		await settle();
		const count = (): number => count_text(view.target, "couldn't create the copy: disk full");
		assert.strictEqual(count(), 1, 'in the drawer');

		toggle();
		await settle();
		assert.isNull(content(view.target));
		assert.strictEqual(count(), 1, 'beside the segments');

		toggle();
		await settle();
		assert.strictEqual(count(), 1, 'in the drawer again');
	});
});
