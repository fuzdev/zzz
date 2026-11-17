// @vitest-environment jsdom

import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';
import { test, assert, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfilePath, SerializableDisknode } from '#lib/diskfile_types.ts';
import DiskfileList from '#lib/DiskfileList.svelte';
import DiskfilePickerDialog from '#lib/DiskfilePickerDialog.svelte';

import FrontendContextHarness from './FrontendContextHarness.svelte';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';

const SOURCE_DIR = parse_or_throw(SerializableDisknode.def.source_dir, '/w/');

/** About the size of the typescript repo, the tree the list's cost was measured on. */
const MANY_FILES = 81_000;

let app: Frontend;
const cleanups: Array<() => void> = [];

const dialog_proto = HTMLDialogElement.prototype;
const dialog_originals = { showModal: dialog_proto.showModal, close: dialog_proto.close };

// jsdom has no `ResizeObserver`, which the windowed list's measuring uses, and no modal dialogs
class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	dialog_proto.showModal = function (this: HTMLDialogElement) {
		this.open = true;
	};
	dialog_proto.close = function (this: HTMLDialogElement) {
		this.open = false;
	};
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = '/w/'; // so the rows show their paths relative, as `a.ts`
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	dialog_proto.showModal = dialog_originals.showModal;
	dialog_proto.close = dialog_originals.close;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const record = (path: string, mtime = 1, size = 1): SerializableDisknode => ({
	id: parse_or_throw(DiskfilePath, path),
	source_dir: SOURCE_DIR,
	size,
	ctime: 1,
	mtime
});

const render = (component: Component<any>, props: Record<string, unknown>): HTMLElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(FrontendContextHarness, { target, props: { app, component, props } });
	flushSync();
	cleanups.push(() => {
		void unmount(mounted);
		target.remove();
		flushSync();
	});
	return target;
};

const seed_many = (): void => {
	const files: Array<SerializableDisknode> = [];
	for (let i = 0; i < MANY_FILES; i++) {
		files.push(record(`/w/d${i % 100}/f${i}.ts`));
	}
	app.diskfiles.add_initial(files);
};

test(
	'a windowed list or picker over many records watches no more paths than it renders rows',
	{ timeout: 60_000 },
	() => {
		seed_many();
		const list = render(DiskfileList, {});
		const list_rows = list.querySelectorAll('li').length;
		assert.ok(list_rows > 0 && list_rows < 100, `windowed, ${list_rows} rows`);
		assert.isAtMost(app.diskfiles.index.watch_count, list_rows);

		// a change on disk re-sorts the list without watching more
		app.diskfiles.upsert(record('/w/d1/f1.ts', 5));
		flushSync();
		assert.isAtMost(app.diskfiles.index.watch_count, list_rows);

		const picker = render(DiskfilePickerDialog, { show: true, onpick: () => undefined });
		const picker_rows = picker.querySelectorAll('li').length;
		assert.ok(picker_rows > 0 && picker_rows < 100, `windowed, ${picker_rows} rows`);
		assert.isAtMost(app.diskfiles.index.watch_count, list_rows + picker_rows);
	}
);

test('the list shows the records on disk and a file kept for its tab after a delete', () => {
	app.diskfiles.add_initial([record('/w/a.ts'), record('/w/b.ts')]);
	app.diskfiles.select(parse_or_throw(DiskfilePath, '/w/b.ts'), true);
	app.diskfiles.remove_by_path('/w/b.ts');
	const target = render(DiskfileList, {});
	const labels = Array.from(target.querySelectorAll('[role="button"]')).map((el) =>
		el.getAttribute('aria-label')
	);
	assert.deepEqual(labels, ['a.ts', 'b.ts, deleted on disk']);
});

test('the picker offers only the records on disk, and gives the picked path', () => {
	app.diskfiles.add_initial([record('/w/a.ts'), record('/w/b.ts')]);
	app.diskfiles.select(parse_or_throw(DiskfilePath, '/w/b.ts'), true);
	app.diskfiles.remove_by_path('/w/b.ts');
	const picked: Array<string | undefined> = [];
	const target = render(DiskfilePickerDialog, {
		show: true,
		onpick: (path: string | undefined) => {
			picked.push(path);
		}
	});
	const buttons = Array.from(target.querySelectorAll<HTMLElement>('[role="button"]'));
	assert.deepEqual(
		buttons.map((el) => el.getAttribute('aria-label')),
		['a.ts']
	);
	buttons[0]!.click();
	flushSync();
	assert.deepEqual(picked, ['/w/a.ts']);
});

const to_labels = (target: HTMLElement): Array<string | null> =>
	Array.from(target.querySelectorAll('[role="button"][aria-label]')).map((el) =>
		el.getAttribute('aria-label')
	);

const choose_sort = (target: HTMLElement, key: string): void => {
	const select = target.querySelector('select');
	assert.ok(select);
	select.value = key;
	select.dispatchEvent(new Event('change'));
	flushSync();
};

for (const [name, component, key] of [
	['the list', DiskfileList, 'updated_newest'],
	['the picker', DiskfilePickerDialog, 'updated_recently'],
	['the picker', DiskfilePickerDialog, 'size_largest']
] as const) {
	test(`${name} re-sorts on a change in place under ${key}, and keeps its order under a path sort`, () => {
		app.diskfiles.add_initial([
			record('/w/a.ts', 3, 3),
			record('/w/b.ts', 2, 2),
			record('/w/c.ts', 1, 1)
		]);
		const target = render(component, {
			show: true,
			show_sort_controls: true,
			onpick: () => undefined
		});
		choose_sort(target, key);
		assert.deepEqual(to_labels(target), ['a.ts', 'b.ts', 'c.ts']);

		// the records are replaced in place, so only the sorter's own tracking re-sorts them
		app.diskfiles.upsert(record('/w/c.ts', 9, 9));
		flushSync();
		assert.deepEqual(to_labels(target), ['c.ts', 'a.ts', 'b.ts']);

		choose_sort(target, 'path_desc');
		assert.deepEqual(to_labels(target), ['c.ts', 'b.ts', 'a.ts']);
		app.diskfiles.upsert(record('/w/a.ts', 99, 99));
		flushSync();
		assert.deepEqual(to_labels(target), ['c.ts', 'b.ts', 'a.ts']);

		// the change is seen once the sort reads it again
		choose_sort(target, key);
		assert.deepEqual(to_labels(target), ['a.ts', 'c.ts', 'b.ts']);
	});
}

test('the list sorts paths as it shows them, relative to the app directory', () => {
	// absolute, `/w/a.ts` sorts before `/x/y.ts`; shown, `/x/y.ts` sorts before `a.ts`
	app.diskfiles.add_initial([
		record('/w/a.ts'),
		{ ...record('/x/y.ts'), source_dir: parse_or_throw(SerializableDisknode.def.source_dir, '/x/') }
	]);
	const target = render(DiskfileList, { show_sort_controls: true });
	assert.deepEqual(to_labels(target), ['/x/y.ts', 'a.ts']);
	choose_sort(target, 'path_desc');
	assert.deepEqual(to_labels(target), ['a.ts', '/x/y.ts']);
});

test('the picker marks the selected paths', () => {
	app.diskfiles.add_initial([record('/w/a.ts'), record('/w/b.ts'), record('/w/c.ts')]);
	const target = render(DiskfilePickerDialog, {
		show: true,
		onpick: () => undefined,
		selected_paths: [parse_or_throw(DiskfilePath, '/w/b.ts')]
	});
	const pressed = Array.from(target.querySelectorAll('[role="button"][aria-label]')).map((el) => [
		el.getAttribute('aria-label'),
		el.getAttribute('aria-pressed')
	]);
	assert.deepEqual(pressed, [
		['a.ts', 'false'],
		['b.ts', 'true'],
		['c.ts', 'false']
	]);
});
