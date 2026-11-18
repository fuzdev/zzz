// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { parse_or_throw } from '@fuzdev/fuz_schema/schema.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import { DiskfileDirectoryPath, DiskfilePath } from '#lib/diskfile_types.ts';
import {
	PALETTE_FILES_MAX,
	create_palette_file_commands,
	to_palette_file_entries,
	create_palette_commands,
	filter_palette_commands,
	to_palette_recency,
	to_palette_recent_key,
	type PaletteCommand
} from '#lib/palette_commands.ts';

import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { write_diskfile } from './diskfile_tree_test_helpers.ts';

const navigation = vi.hoisted(() => ({ goto: vi.fn((_url: string) => Promise.resolve()) }));
vi.mock('$app/navigation', () => navigation);

const MD = parse_or_throw(DiskfilePath, '/w/a/x.md');
const TXT = parse_or_throw(DiskfilePath, '/w/b.txt');

let app: Frontend;

beforeEach(() => {
	vi.spyOn(console, 'log').mockImplementation(() => undefined);
	app = monkeypatch_zzz_for_tests(new Frontend());
	app.zzz_dir = '/w/';
	write_diskfile(app, MD);
	write_diskfile(app, TXT);
});

afterEach(() => {
	app.dispose();
	vi.restoreAllMocks();
});

const labels = (commands: ReadonlyArray<PaletteCommand>): Array<string> =>
	commands.map((c) => c.label);

const find = (label: string): PaletteCommand => {
	const command = create_palette_commands(app).find((c) => c.label === label);
	assert.ok(command, `a "${label}" command`);
	return command;
};

describe('to_palette_recent_key', () => {
	test('drops the path, so a command is one whatever the file', () => {
		assert.strictEqual(to_palette_recent_key('tab_close', { path: MD }), 'tab_close');
		assert.strictEqual(to_palette_recent_key('tab_back', undefined), 'tab_back');
		assert.strictEqual(to_palette_recent_key('tab_back', null), 'tab_back');
		assert.strictEqual(
			to_palette_recent_key('markdown_mode_set', { path: MD, mode: 'source' }),
			to_palette_recent_key('markdown_mode_set', { mode: 'source', path: TXT })
		);
		assert.notStrictEqual(
			to_palette_recent_key('markdown_mode_set', { path: MD, mode: 'source' }),
			to_palette_recent_key('markdown_mode_set', { path: MD, mode: 'preview' })
		);
	});

	test("drops a toggle's direction, so a shortcut's toggle counts for the palette's entry", () => {
		assert.strictEqual(to_palette_recent_key('sidebar_toggle', { show: false }), 'sidebar_toggle');
		assert.strictEqual(to_palette_recent_key('sidebar_toggle', undefined), 'sidebar_toggle');
		assert.strictEqual(
			to_palette_recent_key('desk_pin_toggle', { pinned: true }),
			'desk_pin_toggle'
		);
	});
});

describe('create_palette_commands', () => {
	test('with no tab, only the commands that need none', () => {
		const all = labels(create_palette_commands(app)).filter((l) => !l.startsWith('go '));
		assert.deepEqual(all, [
			'show the files as a tree',
			'hide the sidebar',
			'show the desk menu',
			'pin the desk menu',
			'hide the file details',
			'show the main menu'
		]);
	});

	test("a markdown file's tab adds its tab, reveal, and the modes not shown", () => {
		app.intents.tab_open({ path: MD });
		const all = labels(create_palette_commands(app));
		assert.includeMembers(all, [
			'keep the preview tab open',
			'close the tab',
			'rename the file',
			'reveal the file in the tree',
			'show the markdown preview',
			'show the markdown source'
		]);
		assert.notInclude(all, 'show the markdown split view', 'the mode already shown');
		app.intents.tab_pin({ path: MD });
		assert.notInclude(labels(create_palette_commands(app)), 'keep the preview tab open');
	});

	test('a file that is not markdown gets no markdown modes', () => {
		app.intents.tab_open({ path: TXT, permanent: true });
		assert.notOk(labels(create_palette_commands(app)).some((l) => l.includes('markdown')));
	});

	test('a history holding only the selected file offers no back', () => {
		app.intents.tab_open({ path: MD, permanent: true });
		app.diskfiles.editor.tabs.back_paths = [MD];
		assert.notInclude(labels(create_palette_commands(app)), 'go back');
	});

	test('back, forward, and reopen show only with somewhere to go', () => {
		app.intents.tab_open({ path: MD, permanent: true });
		app.intents.tab_open({ path: TXT, permanent: true });
		assert.include(labels(create_palette_commands(app)), 'go back');
		assert.notInclude(labels(create_palette_commands(app)), 'go forward');
		assert.notInclude(labels(create_palette_commands(app)), 'reopen the closed tab');
		find('go back').run();
		assert.strictEqual(app.diskfiles.selected_path, MD);
		assert.include(labels(create_palette_commands(app)), 'go forward');
		find('close the tab').run();
		assert.include(labels(create_palette_commands(app)), 'reopen the closed tab');
	});

	test('running a command calls its intent with the input bound from app state', () => {
		app.intents.tab_open({ path: MD, permanent: true });
		find('show the markdown source').run();
		find('show the files as a tree').run();
		find('reveal the file in the tree').run();
		assert.deepEqual(
			app.recent_intents.entries.slice(1).map((entry) => [entry.method, entry.input]),
			[
				['markdown_mode_set', { path: MD, mode: 'source' }],
				['explorer_mode_set', { mode: 'tree' }],
				['file_reveal', { path: MD }]
			]
		);
		assert.strictEqual(app.diskfiles.markdown_view_modes.get(MD), 'source');
		// the opposite commands now
		const all = labels(create_palette_commands(app));
		assert.include(all, 'show the files as a list');
		assert.include(all, 'show the markdown split view');
		assert.notInclude(all, 'show the markdown source');
	});

	test('the panel toggles name the way they go, and set it', () => {
		find('hide the sidebar').run();
		assert.isFalse(app.ui.show_sidebar);
		find('show the sidebar').run();
		assert.isTrue(app.ui.show_sidebar);
		find('pin the desk menu').run();
		assert.isTrue(app.ui.desk_pinned);
		assert.include(labels(create_palette_commands(app)), 'unpin the desk menu');
	});

	test('collapsing all folders is a command, not an intent', () => {
		assert.notInclude(labels(create_palette_commands(app)), 'collapse all folders');
		app.intents.file_reveal({ path: MD });
		const command = find('collapse all folders');
		assert.isNull(command.recent_key);
		const before = app.recent_intents.entries.length;
		command.run();
		assert.strictEqual(app.diskfiles.editor.tree.expanded.size, 0);
		assert.strictEqual(app.recent_intents.entries.length, before, 'nothing recorded');
		assert.notInclude(labels(create_palette_commands(app)), 'collapse all folders');
	});

	test('every key is unique', () => {
		app.intents.tab_open({ path: MD });
		app.intents.file_reveal({ path: MD });
		const keys = create_palette_commands(app).map((c) => c.key);
		assert.strictEqual(new Set(keys).size, keys.length);
	});
});

describe('the page and project commands', () => {
	test('every page but the one shown, each going there', () => {
		const all = labels(create_palette_commands(app, '/files'));
		assert.includeMembers(all, ['go home', 'go to chats', 'go to projects', 'go to settings']);
		assert.notInclude(all, 'go to files', 'the page shown');
		const command = create_palette_commands(app, '/files').find((c) => c.label === 'go to chats');
		assert.ok(command);
		command.run();
		assert.deepEqual(app.recent_intents.entries.at(-1)?.input, { view: 'chats' });
		assert.deepEqual(
			navigation.goto.mock.calls.map((call) => call[0]),
			['/chats']
		);
	});
});

describe('the file mode', () => {
	test('"go to a file" switches the mode, offered once anything is indexed', () => {
		const command = create_palette_commands(app).find((c) => c.label === 'go to a file');
		assert.ok(command);
		assert.strictEqual(command.mode, 'files');
	});

	test('ranks a name match first, then a folder or word, then inside one; home as ~', () => {
		app.home_dir = parse_or_throw(DiskfileDirectoryPath, '/w/');
		write_diskfile(app, '/w/x/readme.md');
		write_diskfile(app, '/w/readme/a.md');
		write_diskfile(app, '/w/myreadme.txt');
		const { commands, total } = create_palette_file_commands(
			app,
			to_palette_file_entries(app),
			'README'
		);
		assert.deepEqual(labels(commands), ['~/x/readme.md', '~/readme/a.md', '~/myreadme.txt']);
		assert.strictEqual(total, 3);
		assert.deepEqual(
			labels(create_palette_file_commands(app, to_palette_file_entries(app), '').commands),
			['~/a/x.md', '~/b.txt', '~/myreadme.txt', '~/readme/a.md', '~/x/readme.md'],
			'every file, by path, with no query'
		);
	});

	test('a match at the path’s own start is a folder’s, below a name’s', () => {
		write_diskfile(app, '/w/wx.md');
		const { commands } = create_palette_file_commands(app, to_palette_file_entries(app), '/w');
		// `/w` names `wx.md` by the slash before its name; every path also starts with it
		assert.deepEqual(labels(commands).slice(0, 1), ['/w/wx.md']);
	});

	test('a query starting with a slash matches a name by the slash before it', () => {
		const { commands } = create_palette_file_commands(app, to_palette_file_entries(app), '/b');
		assert.deepEqual(labels(commands), ['/w/b.txt']);
	});

	test('with no file indexed there is no "go to a file"', () => {
		const empty = monkeypatch_zzz_for_tests(new Frontend());
		assert.notInclude(labels(create_palette_commands(empty)), 'go to a file');
		empty.dispose();
	});

	test('the best matches survive the cap, whatever their path', () => {
		for (let i = 0; i <= PALETTE_FILES_MAX; i++) write_diskfile(app, `/w/a/many/xmany${i}.txt`);
		write_diskfile(app, '/w/zz/many.md');
		const { commands } = create_palette_file_commands(app, to_palette_file_entries(app), 'many');
		assert.strictEqual(commands[0]?.label, '/w/zz/many.md', 'a name match, sorted last by path');
	});

	test('lists at most the cap, counting every match', () => {
		for (let i = 0; i <= PALETTE_FILES_MAX; i++) write_diskfile(app, `/w/many/f${i}.txt`);
		const { commands, total } = create_palette_file_commands(
			app,
			to_palette_file_entries(app),
			'many'
		);
		assert.strictEqual(commands.length, PALETTE_FILES_MAX);
		assert.strictEqual(total, PALETTE_FILES_MAX + 1);
	});

	test('a file opens in a preview tab and shows the files page, unless shown', () => {
		const [first] = create_palette_file_commands(
			app,
			to_palette_file_entries(app),
			'b.txt',
			'/chats'
		).commands;
		assert.ok(first);
		first.run();
		assert.strictEqual(app.diskfiles.editor.tabs.preview_tab?.path, TXT);
		assert.deepEqual(
			app.recent_intents.entries.map((e) => [e.method, e.input]),
			[
				['tab_open', { path: TXT }],
				['view_show', { view: 'files' }]
			]
		);
		create_palette_file_commands(
			app,
			to_palette_file_entries(app),
			'x.md',
			'/files'
		).commands[0]!.run();
		assert.strictEqual(app.recent_intents.entries.at(-1)?.method, 'tab_open');
	});
});

describe('the project commands', () => {
	test('the other open projects, by root where two share a name', () => {
		const info = (root: string) => ({
			root: parse_or_throw(DiskfileDirectoryPath, root),
			name: 'zzz'
		});
		app.projects.add(info('/a/zzz/'));
		app.projects.add(info('/b/zzz/'));
		app.projects.add({ root: parse_or_throw(DiskfileDirectoryPath, '/c/other/'), name: 'other' });
		const all = labels(create_palette_commands(app)).filter((l) => l.startsWith('switch'));
		// the first added is active
		assert.deepEqual(all, ['switch to the project /b/zzz/', 'switch to the project other']);
	});
});

describe('filter_palette_commands', () => {
	const command = (label: string, recent_key: string | null = label): PaletteCommand => ({
		key: label,
		label,
		recent_key,
		run: () => undefined
	});
	const commands = [
		command('show the sidebar'),
		command('close the tab'),
		command('tabby thing'),
		command('the stabilizer'),
		command('collapse all folders', null)
	];

	test('an empty query keeps every command in order, the recently used first', () => {
		const recency = new Map([
			['tabby thing', 3],
			['close the tab', 7]
		]);
		assert.deepEqual(labels(filter_palette_commands(commands, '  ', recency)), [
			'close the tab',
			'tabby thing',
			'show the sidebar',
			'the stabilizer',
			'collapse all folders'
		]);
	});

	test('ranks a match at the start, then at a word, then inside one, ignoring case', () => {
		assert.deepEqual(labels(filter_palette_commands(commands, 'TAB', new Map())), [
			'tabby thing',
			'close the tab',
			'the stabilizer'
		]);
	});

	test('a word-start match anywhere in the label counts, not just the first occurrence', () => {
		const list = [command('stab at tabs'), command('xtab')];
		assert.deepEqual(labels(filter_palette_commands(list, 'tab', new Map())), [
			'stab at tabs',
			'xtab'
		]);
	});

	test('the recently used lead within a rank', () => {
		const recency = new Map([['the stabilizer', 1]]);
		const list = [command('a tab'), command('b tab')];
		assert.deepEqual(labels(filter_palette_commands(list, 'tab', new Map([['b tab', 2]]))), [
			'b tab',
			'a tab'
		]);
		assert.deepEqual(labels(filter_palette_commands(commands, 'stab', recency)), [
			'the stabilizer'
		]);
	});

	test('no match, no commands', () => {
		assert.deepEqual(filter_palette_commands(commands, 'zzz', new Map()), []);
	});
});

describe('to_palette_recency', () => {
	test('keeps the newest applied call per key, skipping failures', () => {
		app.intents.sidebar_toggle({ show: false });
		app.intents.tab_open({ path: MD, permanent: true });
		app.intents.tab_close({ path: MD });
		app.intents.sidebar_toggle({ show: false });
		assert.throws(() => app.intents.sidebar_toggle({ show: 'no' } as never));
		const recency = to_palette_recency(app.recent_intents.entries);
		const entries = app.recent_intents.entries;
		assert.strictEqual(recency.get('sidebar_toggle'), entries[3]!.seq);
		assert.strictEqual(recency.get('tab_close'), entries[2]!.seq);
	});
});
