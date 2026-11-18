// @vitest-environment jsdom

import { describe, test, assert, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath } from '#lib/diskfile_types.ts';
import type { ProjectInfoJson } from '#lib/project.svelte.ts';
import DeskMenu from '#lib/DeskMenu.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests, to_visible_text } from './test_helpers.ts';

/** The desk menu's list of open projects, which switches the active one. */

const plain_info = (root: string, name: string): ProjectInfoJson => ({
	root: parse_or_throw(DiskfileDirectoryPath, root),
	name,
	opened_at: '2026-11-16T00:00:00.000Z',
	kind: 'plain_dir',
	registry_path: null,
	fallback: null,
	entries: [],
	focused: [parse_or_throw(DiskfileDirectoryPath, root)],
	ignored: {},
	rev: 1
});

let app: Frontend;
let target: HTMLElement;
let mounted: ReturnType<typeof mount>;

beforeEach(() => {
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.ui.toggle_desk_menu(true);
	app.ui.toggle_desk_pinned(true);
	target = document.createElement('div');
	document.body.append(target);
	mounted = mount(FrontendContextHarness, {
		target,
		props: { app, component: DeskMenu, props: {} }
	});
	flushSync();
});
afterEach(() => {
	void unmount(mounted);
	target.remove();
	app.dispose();
});

const project_buttons = (): Array<HTMLButtonElement> =>
	Array.from(target.querySelectorAll<HTMLButtonElement>('li button'));

describe('the desk menu', () => {
	test('says so when no project is open, and links to the projects page', () => {
		assert.include(to_visible_text(target), 'no projects open');
		assert.strictEqual(target.querySelector('a')?.getAttribute('href'), '/projects');
	});

	test('lists the open projects and switches the active one', () => {
		const a = app.projects.add(plain_info('/w/a/', 'a'));
		const b = app.projects.add(plain_info('/w/b/', 'b'));
		app.projects.activate(a.id);
		flushSync();

		const buttons = project_buttons();
		assert.deepEqual(
			buttons.map((button) => to_visible_text(button)),
			['a /w/a/', 'b /w/b/']
		);
		assert.deepEqual(
			buttons.map((button) => button.classList.contains('selected')),
			[true, false]
		);
		assert.deepEqual(
			buttons.map((button) => button.getAttribute('aria-pressed')),
			['true', 'false']
		);

		buttons[1]!.click();
		flushSync();
		assert.strictEqual(app.projects.active_id, b.id);
		assert.deepEqual(
			app.recent_intents.entries.map((entry) => [entry.method, entry.input]),
			[['project_activate', { root: '/w/b/' }]]
		);
		assert.deepEqual(
			project_buttons().map((button) => button.getAttribute('aria-pressed')),
			['false', 'true']
		);
	});

	test('marks a project whose watches are degraded', () => {
		const a = app.projects.add(plain_info('/w/a/', 'a'));
		a.watch_status = 'degraded';
		flushSync();
		assert.strictEqual(to_visible_text(project_buttons()[0]!), 'a /w/a/ polled');
	});
});
