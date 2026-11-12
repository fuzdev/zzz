// @vitest-environment jsdom

import { test, describe, assert, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import type FuzTerminal from '#lib/fuz_terminal/FuzTerminal.svelte';
import {
	FUZ_TERMINAL_MAX_CALLBACK_WRITES,
	FuzTerminalState,
	type FuzTerminalOptions,
	type FuzTerminalStatus
} from '#lib/fuz_terminal/fuz_terminal_state.svelte.ts';
import { is_fuz_terminal_key_target } from '#lib/fuz_terminal/fuz_terminal_keyboard.ts';
import {
	create_fuz_terminal_deps,
	get_fuz_terminal_selection_text
} from '#lib/fuz_terminal/fuz_terminal_deps.ts';
import type { FuzTerminalMeasurement } from '#lib/fuz_terminal/fuz_terminal_layout.ts';
import type { GhosttyVt } from '#lib/fuz_terminal/ghostty_vt.ts';

import FuzTerminalHarness from './FuzTerminalHarness.svelte';
import {
	create_test_fuz_terminal_deps,
	measurement_for,
	type TestFuzTerminalDeps
} from './fuz_terminal_test_helpers.ts';
import {
	compile_test_ghostty_vt,
	load_test_ghostty_vt,
	load_wrapped_ghostty_vt
} from './ghostty_vt_test_helpers.ts';

// counts row renders: the row snippet splits its runs once each time it runs
const { split_calls } = vi.hoisted(() => ({
	split_calls: [] as Array<ReadonlyArray<unknown>>
}));
vi.mock('#lib/fuz_terminal/fuz_terminal_layout.ts', async (import_original) => {
	const original =
		await import_original<typeof import('#lib/fuz_terminal/fuz_terminal_layout.ts')>();
	return {
		...original,
		split_fuz_terminal_runs: (runs: Parameters<typeof original.split_fuz_terminal_runs>[0]) => {
			split_calls.push(runs);
			return original.split_fuz_terminal_runs(runs);
		}
	};
});

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Mounted {
	deps: TestFuzTerminalDeps;
	target: HTMLElement;
	root: HTMLElement;
	view: FuzTerminal;
	statuses: Array<FuzTerminalStatus>;
	/** Run the pending frames and flush the DOM. */
	step: () => void;
	unmount: () => void;
}

/**
 * Mount a terminal view under test deps and wait until it leaves `loading`.
 * The default measurement fits 20 × 4 cells.
 */
const mount_terminal = async (
	options: {
		props?: Partial<FuzTerminalOptions>;
		measurement?: FuzTerminalMeasurement | null;
		load_vt?: (module: WebAssembly.Module) => Promise<GhosttyVt>;
		/** Called with the view as soon as it's mounted. */
		oninstance?: (view: FuzTerminal) => void;
	} = {}
): Promise<Mounted> => {
	const module = await compile_test_ghostty_vt();
	const deps = create_test_fuz_terminal_deps(
		options.load_vt ?? (() => load_test_ghostty_vt()),
		options.measurement === undefined ? measurement_for(20, 4) : options.measurement
	);
	const statuses: Array<FuzTerminalStatus> = [];
	let settled!: () => void;
	const left_loading = new Promise<void>((resolve) => (settled = resolve));
	const target = document.createElement('div');
	document.body.append(target);
	let view: FuzTerminal | undefined;
	const user_onstatus = options.props?.onstatus;
	const mounted = mount(FuzTerminalHarness, {
		target,
		props: {
			deps,
			props: {
				module,
				...options.props,
				onstatus: (status: FuzTerminalStatus) => {
					statuses.push(status);
					user_onstatus?.(status);
					settled();
				}
			},
			oninstance: (instance: FuzTerminal) => {
				view = instance;
				written_by_host = instance;
				options.oninstance?.(instance);
			}
		}
	});
	flushSync();
	let unmounted = false;
	const do_unmount = (): void => {
		if (unmounted) return;
		unmounted = true;
		void unmount(mounted);
		flushSync();
		target.remove();
	};
	cleanups.push(do_unmount);
	await left_loading;
	flushSync();
	assert.ok(view, 'the harness handed back the view');
	const root = target.querySelector<HTMLElement>('.fuz-terminal');
	assert.ok(root);
	return {
		deps,
		target,
		root,
		view,
		statuses,
		step: () => {
			deps.frames.step();
			flushSync();
		},
		unmount: do_unmount
	};
};

/** The view under test, for callbacks that write back to it (set when each view mounts). */
let written_by_host: FuzTerminal | undefined;

const row_elements = (root: HTMLElement): Array<HTMLElement> =>
	Array.from(root.querySelectorAll<HTMLElement>('.fuz-terminal-row'));

const rows_text = (root: HTMLElement): Array<string> =>
	row_elements(root).map((row) => row.textContent);

const run_elements = (row: HTMLElement): Array<HTMLElement> =>
	Array.from(row.querySelectorAll<HTMLElement>('.run'));

/** A run's boxed width in cells, from its `--run_width`. */
const run_width = (run: HTMLElement): string => run.style.getPropertyValue('--run_width');

/** A run's first column, from its `--run_x`: where it's drawn, whatever runs come before it. */
const run_x = (run: HTMLElement): string => run.style.getPropertyValue('--run_x');

const cursor_element = (root: HTMLElement): HTMLElement | null =>
	root.querySelector<HTMLElement>('.cursor');

describe('drawing', () => {
	test('the first frame: every row, each run boxed to its columns', async () => {
		const t = await mount_terminal();
		assert.deepEqual(t.statuses, [{ kind: 'ready' }]);
		assert.deepEqual(t.view.get_size(), { cols: 20, rows: 4 });
		t.view.write('hello\r\nworld');
		t.step();
		assert.deepEqual(rows_text(t.root), ['hello', 'world', '', '']);
		const [first] = row_elements(t.root);
		const runs = run_elements(first!);
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(run_width(runs[0]!), '5');
		// a default-styled run carries nothing but its column and width
		assert.strictEqual(
			runs[0]!.getAttribute('style')?.replace(/[\s;]+$/, ''),
			'--run_x: 0; --run_width: 5'
		);
	});

	test('rows hold their runs and nothing else: no stray whitespace text', async () => {
		const t = await mount_terminal();
		t.view.write(`a${ESC}[1mb${ESC}[0m c`);
		t.step();
		const [row] = row_elements(t.root);
		// Svelte may leave an empty text node as an anchor, which draws and copies nothing
		for (const node of row!.childNodes) {
			if (node.nodeType === Node.TEXT_NODE) assert.strictEqual(node.textContent, '');
		}
		assert.deepEqual(
			run_elements(row!).map((run) => [run.textContent, run_x(run), run_width(run)]),
			[
				['a', '0', '1'],
				['b', '1', '1'],
				[' c', '2', '2']
			]
		);
		for (const run of run_elements(row!)) {
			assert.deepEqual(
				Array.from(run.childNodes).map((n) => n.nodeType),
				[Node.TEXT_NODE],
				'a run is one text node'
			);
		}
	});

	test('colored and flagged text gets its style and classes', async () => {
		const t = await mount_terminal({ measurement: measurement_for(40, 2) });
		t.view.write(
			`${ESC}[31mred${ESC}[0m${ESC}[1;4:3mbold${ESC}[0m${ESC}[38;2;1;2;3mrgb${ESC}[0m${ESC}[5mblink${ESC}[0m${ESC}[7minv${ESC}[0m`
		);
		t.step();
		const runs = run_elements(row_elements(t.root)[0]!);
		assert.deepEqual(
			runs.map((r) => r.textContent),
			['red', 'bold', 'rgb', 'blink', 'inv']
		);
		const style = (i: number): string => runs[i]!.getAttribute('style') ?? '';
		assert.include(style(0), 'color: var(--fuz_terminal_palette_1)');
		assert.include(style(1), 'font-weight: bold');
		assert.include(style(1), 'text-decoration-style: wavy');
		// jsdom serializes a hex color as `rgb()`
		assert.include(style(2), 'color: rgb(1, 2, 3)');
		assert.isTrue(runs[3]!.classList.contains('run-blink'));
		assert.isFalse(runs[0]!.classList.contains('run-blink'));
		assert.include(style(4), 'background-color: var(--fuz_terminal_fg)');
	});

	test('program output reaches the DOM as text, never markup', async () => {
		const t = await mount_terminal({ measurement: measurement_for(40, 2) });
		t.view.write('<img src=x onerror=alert(1)>');
		t.step();
		assert.isNull(t.root.querySelector('img'));
		assert.strictEqual(rows_text(t.root)[0], '<img src=x onerror=alert(1)>');
	});

	test('hyperlinks are marked by a class, with no link to follow', async () => {
		const t = await mount_terminal();
		t.view.write(`${ESC}]8;;https://a.fuz.dev/${ST}link${ESC}]8;;${ST} plain`);
		t.step();
		const runs = run_elements(row_elements(t.root)[0]!);
		assert.deepEqual(
			runs.map((r) => [r.textContent, r.classList.contains('run-link')]),
			[
				['link', true],
				[' plain', false]
			]
		);
		assert.isNull(t.root.querySelector('a'));
	});

	test('wide characters and graphemes are boxed clusters; mixed text splits at ASCII', async () => {
		const t = await mount_terminal();
		t.view.write('a漢b─┼c');
		t.step();
		const runs = run_elements(row_elements(t.root)[0]!);
		assert.deepEqual(
			runs.map((r) => [r.textContent, run_x(r), run_width(r), r.classList.contains('run-cluster')]),
			[
				['a', '0', '1', false],
				['漢', '1', '2', true],
				['b', '3', '1', false],
				['─┼', '4', '2', false],
				['c', '6', '1', false]
			]
		);
	});
});

describe('the frame loop', () => {
	test('idle with nothing to draw; many writes, one frame', async () => {
		const t = await mount_terminal();
		t.step();
		assert.strictEqual(t.deps.frames.pending, 0, 'idle');
		const before = t.deps.frames.requested;
		for (let i = 0; i < 20; i++) t.view.write(`${i} `);
		assert.strictEqual(t.deps.frames.requested - before, 1);
		assert.deepEqual(rows_text(t.root)[0], '', 'nothing drawn before the frame');
		t.step();
		assert.strictEqual(rows_text(t.root)[0], '0 1 2 3 4 5 6 7 8 9');
		assert.strictEqual(t.deps.frames.pending, 0);
	});

	test('an unchanged row keeps its element and nodes; a changed one is updated', async () => {
		const t = await mount_terminal();
		t.view.write('one\r\ntwo');
		t.step();
		const [first, second] = row_elements(t.root);
		const first_run = run_elements(first!)[0]!;
		const first_text = first_run.firstChild;
		const mutations: Array<MutationRecord> = [];
		const observer = new MutationObserver((records) => mutations.push(...records));
		observer.observe(t.root, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true
		});
		split_calls.length = 0;
		t.view.write('!');
		t.step();
		// only the changed row's block ran: the unchanged rows are the same objects, skipped
		assert.strictEqual(split_calls.length, 1, 'one row rendered');
		assert.strictEqual(
			(split_calls[0]![0] as { text: string }).text,
			'two!',
			'the changed row rendered'
		);
		const records = observer.takeRecords();
		mutations.push(...records);
		observer.disconnect();
		const [first_after, second_after] = row_elements(t.root);
		assert.strictEqual(first_after, first, 'the same row element');
		assert.strictEqual(run_elements(first_after!)[0], first_run, 'the same run element');
		assert.strictEqual(run_elements(first_after!)[0]!.firstChild, first_text, 'the same text node');
		assert.strictEqual(second_after, second);
		assert.deepEqual(rows_text(t.root), ['one', 'two!', '', '']);
		// nothing under the unchanged row was touched
		assert.isFalse(
			mutations.some((m) => first!.contains(m.target)),
			'no mutation inside the unchanged row'
		);
		assert.isTrue(mutations.some((m) => second!.contains(m.target)));
	});

	test('a scroll moves the rows still on screen: the same elements, by key', async () => {
		const t = await mount_terminal();
		t.view.write('a\r\nb\r\nc\r\nd');
		t.step();
		const before = row_elements(t.root);
		t.view.write('\r\ne');
		t.step();
		const after = row_elements(t.root);
		assert.deepEqual(rows_text(t.root), ['b', 'c', 'd', 'e']);
		assert.strictEqual(after[0], before[1]);
		assert.strictEqual(after[1], before[2]);
		assert.strictEqual(after[2], before[3]);
		assert.notInclude(after, before[0]);
	});

	test('the theme: a palette entry a program changes overrides the theme’s, and a reset restores it', async () => {
		const t = await mount_terminal();
		const style = (): string => t.root.getAttribute('style') ?? '';
		assert.notInclude(style(), '--fuz_terminal_palette_1:');
		assert.include(style(), '--fuz_terminal_palette_16: #000000');
		t.view.write(`${ESC}]4;1;rgb:12/34/56${ST}`);
		t.step();
		assert.include(style(), '--fuz_terminal_palette_1: #123456');
		t.view.write(`${ESC}]104;1${ST}`);
		t.step();
		assert.notInclude(style(), '--fuz_terminal_palette_1:');
	});

	test('default colors: the theme’s until a program sets both', async () => {
		const t = await mount_terminal();
		const style = (): string => t.root.getAttribute('style') ?? '';
		assert.notInclude(style(), '--fuz_terminal_fg:');
		t.view.write(`${ESC}]10;rgb:11/22/33${ST}`);
		t.step();
		// the library takes the defaults only as a pair: one alone changes nothing
		assert.notInclude(style(), '--fuz_terminal_fg:');
		t.view.write(`${ESC}]11;rgb:44/55/66${ST}`);
		t.step();
		assert.include(style(), '--fuz_terminal_fg: #112233');
		assert.include(style(), '--fuz_terminal_bg: #445566');
	});
});

describe('the cursor', () => {
	test('drawn at its cell, a block over the text when focused, hollow otherwise', async () => {
		const t = await mount_terminal();
		t.view.write('abc\r\nde\x08');
		t.step();
		const cursor = cursor_element(t.root);
		assert.ok(cursor);
		assert.strictEqual(cursor.style.getPropertyValue('--cursor_x'), '1');
		assert.strictEqual(cursor.style.getPropertyValue('--cursor_y'), '1');
		assert.strictEqual(cursor.style.getPropertyValue('--cursor_width'), '1');
		assert.isTrue(cursor.classList.contains('cursor-block-hollow'), 'unfocused');
		assert.strictEqual(cursor.textContent, '');
		t.view.focus();
		flushSync();
		const focused = cursor_element(t.root)!;
		assert.isTrue(focused.classList.contains('cursor-block'));
		assert.strictEqual(focused.textContent, 'e');
		t.root.blur();
		flushSync();
		assert.isTrue(cursor_element(t.root)!.classList.contains('cursor-block-hollow'));
	});

	test('its shape, blinking, a wide character, and hidden', async () => {
		const t = await mount_terminal();
		t.view.focus();
		t.view.write(`${ESC}[6 q`);
		t.step();
		let cursor = cursor_element(t.root)!;
		assert.isTrue(cursor.classList.contains('cursor-bar'));
		assert.isFalse(cursor.classList.contains('cursor-blinking'));
		t.view.write(`${ESC}[3 q`);
		t.step();
		cursor = cursor_element(t.root)!;
		assert.isTrue(cursor.classList.contains('cursor-underline'));
		assert.isTrue(cursor.classList.contains('cursor-blinking'));
		// on the tail of a wide character: both its columns
		t.view.write(`${ESC}[2 q漢\x08`);
		t.step();
		cursor = cursor_element(t.root)!;
		assert.strictEqual(cursor.style.getPropertyValue('--cursor_x'), '0');
		assert.strictEqual(cursor.style.getPropertyValue('--cursor_width'), '2');
		assert.strictEqual(cursor.textContent, '漢');
		t.view.write(`${ESC}[?25l`);
		t.step();
		assert.isNull(cursor_element(t.root));
		t.view.write(`${ESC}[?25h`);
		t.step();
		assert.ok(cursor_element(t.root));
	});
});

describe('replayed output and replies', () => {
	/** A view whose module loads only once `open` is called, recording replies and bells. */
	const mount_gated = async (
		before_ready: (view: FuzTerminal) => void,
		props: Partial<FuzTerminalOptions> = {}
	): Promise<Mounted & { replies: Array<string>; bells: () => number }> => {
		const replies: Array<string> = [];
		let bells = 0;
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const t = await mount_terminal({
			props: {
				ondata: (data) => replies.push(new TextDecoder().decode(data)),
				onbell: () => bells++,
				...props
			},
			load_vt: async () => {
				await gate;
				return load_test_ghostty_vt();
			},
			oninstance: (view) => {
				assert.strictEqual(view.get_status().kind, 'loading');
				before_ready(view);
				open();
			}
		});
		return { ...t, replies, bells: () => bells };
	};

	const QUERY = `${ESC}[6n`;

	test('replay and live both written while loading: only the live query is answered', async () => {
		const t = await mount_gated((view) => {
			view.write(`old${QUERY}${BEL}`, { replay: true });
			view.write(`|new${QUERY}${BEL}`);
		});
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'old|new');
		assert.deepEqual(t.replies, [`${ESC}[1;8R`]);
		assert.strictEqual(t.bells(), 1);
	});

	test('replay while loading, live once ready', async () => {
		const t = await mount_gated((view) => view.write(`old${QUERY}${BEL}`, { replay: true }));
		assert.deepEqual(t.replies, []);
		assert.strictEqual(t.bells(), 0);
		t.view.write(`|new${QUERY}${BEL}`);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'old|new');
		assert.deepEqual(t.replies, [`${ESC}[1;8R`]);
		assert.strictEqual(t.bells(), 1);
	});

	test('replay and live both once ready, in either order', async () => {
		const replies: Array<string> = [];
		const t = await mount_terminal({
			props: { ondata: (data) => replies.push(new TextDecoder().decode(data)) }
		});
		t.view.write(`a${QUERY}`, { replay: true });
		t.view.write(`b${QUERY}`);
		t.view.write(`c${QUERY}`, { replay: true });
		t.view.write(`d${QUERY}`);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'abcd');
		// the live queries only, each at the cursor where it was parsed
		assert.deepEqual(replies, [`${ESC}[1;3R`, `${ESC}[1;5R`]);
	});

	test('interleaved while loading and after: written in call order, live queries answered', async () => {
		const t = await mount_gated((view) => {
			view.write(`1${QUERY}`);
			view.write(`2${QUERY}`, { replay: true });
			view.write(`3${QUERY}`);
		});
		t.view.write(`4${QUERY}`, { replay: true });
		t.view.write(`5${QUERY}`);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], '12345');
		assert.deepEqual(t.replies, [`${ESC}[1;2R`, `${ESC}[1;4R`, `${ESC}[1;6R`]);
	});

	test('a replay’s title reaches the host, and a hold it leaves open is honored', async () => {
		const titles: Array<string> = [];
		const t = await mount_gated(
			(view) =>
				view.write(`${ESC}]2;from replay${ST}shown${ESC}[?2026h\r${ESC}[2Khidden`, {
					replay: true
				}),
			{ ontitle: (title) => titles.push(title) }
		);
		assert.deepEqual(titles, ['from replay']);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'shown', 'held');
		assert.strictEqual(t.deps.timers.pending, 1);
		t.deps.timers.advance(1000);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'hidden');
	});

	test('a write from onstatus(ready) comes after what was written while loading', async () => {
		const t = await mount_gated(
			(view) => {
				view.write('A');
				view.write('B', { replay: true });
			},
			{
				onstatus: (status) => {
					if (status.kind === 'ready') written_by_host?.write('C');
				}
			}
		);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'ABC');
	});

	test('a write from onresize comes after what was written while loading, at creation and later', async () => {
		const t = await mount_gated((view) => view.write('A'), {
			onresize: (size) => written_by_host?.write(`<${size.cols}>`)
		});
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'A<20>');
		t.deps.measurement = measurement_for(30, 4);
		t.deps.fire_resize();
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'A<20><30>');
	});

	test('a write from a callback inside a write runs right after it', async () => {
		const echo: { view?: FuzTerminal } = {};
		const t = await mount_terminal({
			props: {
				ondata: () => echo.view?.write('[echo]')
			}
		});
		echo.view = t.view;
		t.view.write(`x${ESC}[6ny`);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'xy[echo]');
		assert.isNull(t.root.querySelector('.message'), 'nothing failed');
	});

	test('get_text reads the screen as plain text', async () => {
		const t = await mount_terminal();
		t.view.write('one  \r\ntwo');
		assert.strictEqual(t.view.get_text(), 'one\ntwo');
	});
});

describe('render holds', () => {
	test('a hold keeps the frame from its start until it ends', async () => {
		const t = await mount_terminal();
		t.view.write('done');
		t.step();
		t.view.write(`${ESC}[?2026h\r${ESC}[2Khalf`);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'done', 'held');
		assert.strictEqual(t.deps.timers.pending, 1, 'the hold has a timeout');
		t.view.write(` more${ESC}[?2026l`);
		assert.strictEqual(t.deps.timers.pending, 0, 'its timeout cleared');
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'half more');
	});

	test('the frame a hold starts on is drawn, though later bytes of its write were parsed', async () => {
		const t = await mount_terminal();
		t.view.write(`before${ESC}[?2026h\r${ESC}[2Kafter`);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'before');
	});

	test('a hold that never ends times out, and the view draws again', async () => {
		const t = await mount_terminal();
		t.view.write(`stuck${ESC}[?2026h\r${ESC}[2Knew`);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'stuck');
		t.deps.timers.advance(999);
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'stuck', 'still held');
		t.deps.timers.advance(1);
		assert.strictEqual(t.deps.frames.pending, 1, 'the timeout requests a frame');
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'new');
		t.view.write('!');
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'new!', 'and keeps drawing');
	});
});

describe('sizing', () => {
	test('the terminal follows the box; a storm of changes is one resize per frame', async () => {
		const sizes: Array<string> = [];
		const t = await mount_terminal({
			props: { onresize: ({ cols, rows }) => sizes.push(`${cols}x${rows}`) }
		});
		assert.deepEqual(sizes, ['20x4']);
		for (let i = 0; i < 10; i++) {
			t.deps.measurement = measurement_for(30 + i, 6);
			t.deps.fire_resize();
		}
		assert.strictEqual(t.deps.frames.pending, 1);
		t.step();
		assert.deepEqual(sizes, ['20x4', '39x6']);
		assert.deepEqual(t.view.get_size(), { cols: 39, rows: 6 });
		assert.strictEqual(row_elements(t.root).length, 6);
		// the same size again: no resize
		t.deps.fire_resize();
		t.step();
		assert.deepEqual(sizes, ['20x4', '39x6']);
	});

	test('an unmeasurable box never resizes', async () => {
		const sizes: Array<string> = [];
		const t = await mount_terminal({
			props: { onresize: ({ cols, rows }) => sizes.push(`${cols}x${rows}`) }
		});
		for (const measurement of [
			null,
			{ width: 0, height: 0, cell_width: 8, cell_height: 16 },
			{ width: 800, height: 400, cell_width: 0, cell_height: 16 },
			{ width: 800, height: 400, cell_width: 8, cell_height: NaN }
		]) {
			t.deps.measurement = measurement;
			t.deps.fire_resize();
			t.step();
		}
		assert.deepEqual(sizes, ['20x4']);
		assert.deepEqual(t.view.get_size(), { cols: 20, rows: 4 });
	});

	test('unmeasurable at creation: the default size, then the box once it can be measured', async () => {
		const sizes: Array<string> = [];
		const t = await mount_terminal({
			measurement: null,
			props: { onresize: ({ cols, rows }) => sizes.push(`${cols}x${rows}`) }
		});
		assert.deepEqual(sizes, ['80x24']);
		t.deps.measurement = measurement_for(10, 3);
		t.deps.fire_resize();
		t.step();
		assert.deepEqual(sizes, ['80x24', '10x3']);
	});
});

describe('failure', () => {
	test('a module that fails to instantiate shows a plain message', async () => {
		const t = await mount_terminal({
			load_vt: () => Promise.reject(new Error('no wasm here'))
		});
		assert.strictEqual(t.statuses.length, 1);
		assert.strictEqual(t.statuses[0]!.kind, 'failed');
		assert.strictEqual(t.view.get_status().kind, 'failed');
		assert.strictEqual(
			t.root.querySelector('.message')?.textContent,
			'the terminal failed: no wasm here'
		);
		// writes and reads after failing are quiet
		t.view.write('ignored');
		assert.strictEqual(t.view.get_text(), '');
		assert.strictEqual(t.deps.frames.pending, 0);
	});

	test('a terminal that can’t be created fails the view', async () => {
		const t = await mount_terminal({
			load_vt: () =>
				load_wrapped_ghostty_vt(() => ({
					ghostty_terminal_new: () => 1 // a GhosttyResult that isn't success
				}))
		});
		assert.strictEqual(t.view.get_status().kind, 'failed');
		assert.include(t.root.querySelector('.message')?.textContent, 'ghostty_terminal_new');
	});

	test('a poisoned instance stops drawing, says so, and tells the host', async () => {
		const fail = { on: false };
		const boom = new Error('trap');
		const t = await mount_terminal({
			load_vt: () =>
				load_wrapped_ghostty_vt((exports) => ({
					ghostty_render_state_update: (...args: Array<unknown>) => {
						if (fail.on) throw boom;
						return exports.ghostty_render_state_update(...args);
					}
				}))
		});
		t.view.write('before');
		t.step();
		fail.on = true;
		t.view.write(' after');
		t.step();
		const status = t.view.get_status();
		assert.strictEqual(status.kind, 'poisoned');
		assert(status.kind === 'poisoned');
		assert.strictEqual(status.error, boom);
		assert.deepEqual(
			t.statuses.map((s) => s.kind),
			['ready', 'poisoned']
		);
		assert.include(t.root.querySelector('.message')?.textContent, 'must be reopened');
		assert.strictEqual(rows_text(t.root)[0], 'before', 'the last frame stays');
		t.view.write('more');
		assert.strictEqual(t.deps.frames.pending, 0, 'nothing more is drawn');
	});

	test('a callback that throws is reported, and the terminal goes on', async () => {
		const errors: Array<unknown> = [];
		const boom = new Error('host bug');
		const t = await mount_terminal({
			props: {
				onbell: () => {
					throw boom;
				},
				onerror: (error) => errors.push(error)
			}
		});
		t.view.write(`a${BEL}b`);
		t.step();
		assert.deepEqual(errors, [boom]);
		assert.strictEqual(t.view.get_status().kind, 'ready');
		assert.strictEqual(rows_text(t.root)[0], 'ab');
		assert.strictEqual(
			t.root.querySelector('.message')?.textContent,
			'a terminal callback failed: host bug'
		);
	});

	test('a callback error with no usable message is still reported', async () => {
		const errors: Array<unknown> = [];
		const boom = new Error();
		const unprintable = {
			toString: () => {
				throw new Error('no string');
			}
		};
		Object.defineProperty(boom, 'message', { value: unprintable });
		const t = await mount_terminal({
			props: {
				onbell: () => {
					throw boom;
				},
				onerror: (error) => errors.push(error)
			}
		});
		t.view.write(`a${BEL}b`);
		t.step();
		assert.deepEqual(errors, [boom]);
		assert.strictEqual(t.view.get_status().kind, 'ready');
		assert.strictEqual(rows_text(t.root)[0], 'ab');
		assert.strictEqual(
			t.root.querySelector('.message')?.textContent,
			'a terminal callback failed: a value that has no message'
		);
	});

	test('a resize callback that throws, from a frame, is reported, not thrown', async () => {
		const errors: Array<unknown> = [];
		const t = await mount_terminal({
			props: {
				onresize: (size) => {
					if (size.cols === 30) throw new Error('resize bug');
				},
				onerror: (error) => errors.push(error)
			}
		});
		t.deps.measurement = measurement_for(30, 4);
		t.deps.fire_resize();
		t.step();
		assert.strictEqual(errors.length, 1);
		assert.deepEqual(t.view.get_size(), { cols: 30, rows: 4 });
	});
});

describe('unmounting', () => {
	test('disposes everything: no frame, timer, observer, or call into the module after', async () => {
		let calls = 0;
		const t = await mount_terminal({
			load_vt: () =>
				load_wrapped_ghostty_vt((exports) => {
					const counted: Record<string, unknown> = {};
					for (const [name, value] of Object.entries(exports)) {
						if (typeof value !== 'function') continue;
						counted[name] = (...args: Array<unknown>): unknown => {
							calls++;
							return value(...args);
						};
					}
					return counted;
				})
		});
		t.view.write(`x${ESC}[?2026h`); // a hold, so a timer is pending
		assert.strictEqual(t.deps.timers.pending, 1);
		assert.strictEqual(t.deps.frames.pending, 1);
		assert.strictEqual(t.deps.observing, 1);
		const view = t.view;
		const before_unmount = calls;
		t.unmount();
		assert.isAbove(calls, before_unmount, 'freeing called in');
		const after_unmount = calls;
		assert.strictEqual(t.deps.frames.pending, 0);
		assert.strictEqual(t.deps.timers.pending, 0);
		assert.strictEqual(t.deps.observing, 0);
		// a stray callback or host call after unmount reaches nothing
		view.write('late');
		assert.strictEqual(view.get_text(), '');
		t.deps.frames.step();
		t.deps.timers.advance(5000);
		t.deps.fire_resize();
		assert.strictEqual(calls, after_unmount);
	});

	test('unmounted while loading: the instance is dropped unused', async () => {
		const module = await compile_test_ghostty_vt();
		let resolve_vt!: (vt: GhosttyVt) => void;
		const deps = create_test_fuz_terminal_deps(
			() => new Promise((resolve) => (resolve_vt = resolve)),
			measurement_for(20, 4)
		);
		const statuses: Array<FuzTerminalStatus> = [];
		const target = document.createElement('div');
		document.body.append(target);
		const mounted = mount(FuzTerminalHarness, {
			target,
			props: { deps, props: { module, onstatus: (s) => statuses.push(s) }, oninstance: () => {} }
		});
		flushSync();
		// the instantiate is in flight
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.isFunction(resolve_vt);
		void unmount(mounted);
		flushSync();
		target.remove();
		let calls = 0;
		const vt = await load_wrapped_ghostty_vt((exports) => {
			const counted: Record<string, unknown> = {};
			for (const [name, value] of Object.entries(exports)) {
				if (typeof value !== 'function') continue;
				counted[name] = (...args: Array<unknown>): unknown => {
					calls++;
					return value(...args);
				};
			}
			return counted;
		});
		// constructing the instance called in; only what follows counts
		calls = 0;
		resolve_vt(vt);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.strictEqual(calls, 0);
		assert.deepEqual(statuses, []);
		assert.strictEqual(deps.frames.pending, 0);
	});
});

/** A load that counts every call into the instance after it's made (construction excluded). */
const counted_load = (): {
	load_vt: () => Promise<GhosttyVt>;
	calls: () => number;
	fail: { call: string | null; error: Error };
} => {
	let calls = 0;
	let counting = false;
	const fail: { call: string | null; error: Error } = { call: null, error: new Error('trap') };
	return {
		calls: () => calls,
		fail,
		load_vt: async () => {
			const vt = await load_wrapped_ghostty_vt((exports) => {
				const counted: Record<string, unknown> = {};
				for (const [name, value] of Object.entries(exports)) {
					if (typeof value !== 'function') continue;
					counted[name] = (...args: Array<unknown>): unknown => {
						if (counting) calls++;
						if (name === fail.call) throw fail.error;
						return value(...args);
					};
				}
				return counted;
			});
			counting = true;
			return vt;
		}
	};
};

describe('colors and the cursor color', () => {
	test('reverse video over the theme’s defaults isn’t drawn: the library swaps only colors a program set', async () => {
		const t = await mount_terminal();
		const before = t.root.getAttribute('style');
		t.view.write(`${ESC}[?5h`);
		t.step();
		assert.strictEqual(t.root.getAttribute('style'), before);
		assert.notInclude(before ?? '', '--fuz_terminal_fg:');
	});

	test('a program’s cursor color is its own property; the palette string is left alone', async () => {
		const t = await mount_terminal();
		const theme = (): string =>
			(t.root.getAttribute('style') ?? '').replace(/;?\s*--fuz_terminal_cursor:[^;]*/, '');
		const before = theme();
		assert.strictEqual(t.root.style.getPropertyValue('--fuz_terminal_cursor'), '');
		t.view.write(`${ESC}]12;rgb:00/ff/00${ST}`);
		t.step();
		assert.strictEqual(t.root.style.getPropertyValue('--fuz_terminal_cursor'), '#00ff00');
		assert.strictEqual(theme(), before);
		t.view.write(`${ESC}]112${ST}`);
		t.step();
		assert.strictEqual(t.root.style.getPropertyValue('--fuz_terminal_cursor'), '');
	});

	test('the measured cell sizes every box, as custom properties on the root', async () => {
		const t = await mount_terminal({
			measurement: { width: 200, height: 70, cell_width: 8.5, cell_height: 17 }
		});
		assert.strictEqual(t.root.style.getPropertyValue('--fuz_terminal_cell_width'), '8.5px');
		assert.strictEqual(t.root.style.getPropertyValue('--fuz_terminal_cell_height'), '17px');
		t.deps.measurement = { width: 200, height: 70, cell_width: 9, cell_height: 18 };
		t.deps.fire_resize();
		t.step();
		assert.strictEqual(t.root.style.getPropertyValue('--fuz_terminal_cell_width'), '9px');
	});

	test('unmeasured: no cell properties, so the boxes fall back to the font’s own', async () => {
		const t = await mount_terminal({ measurement: null });
		assert.strictEqual(t.root.style.getPropertyValue('--fuz_terminal_cell_width'), '');
		assert.strictEqual(t.root.style.getPropertyValue('--fuz_terminal_cell_height'), '');
	});
});

describe('structure', () => {
	test('a root box holding a layer of block rows of inline runs, a cursor, and a probe', async () => {
		const t = await mount_terminal();
		t.view.write(`a${ESC}[31mb`);
		t.step();
		const children = Array.from(t.root.children).map((child) => child.className.split(' ')[0]);
		assert.deepEqual(children, ['fuz-terminal-screen', 'probe']);
		const screen = t.root.querySelector('.fuz-terminal-screen')!;
		// the rows and cursor live in the layer, never as the root's own content
		assert.strictEqual(screen.querySelectorAll('.fuz-terminal-row').length, 4);
		assert.ok(screen.querySelector('.cursor'));
		for (const row of row_elements(t.root)) {
			assert.strictEqual(row.parentElement, screen);
			assert.strictEqual(row.tagName, 'DIV');
			for (const run of run_elements(row)) assert.strictEqual(run.tagName, 'SPAN');
		}
	});
});

describe('guards', () => {
	test('a hold that begins after a callback unmounted the view, in the same write, does nothing', async () => {
		const { load_vt, calls } = counted_load();
		const t = await mount_terminal({
			load_vt,
			props: { ontitle: () => t_ref.unmount() }
		});
		const t_ref = t;
		t.view.write(`abc${ESC}]2;x${ST}${ESC}[?2026hdef`);
		const after = calls();
		assert.strictEqual(t.deps.timers.pending, 0, 'no hold timer');
		assert.strictEqual(t.deps.frames.pending, 0);
		t.deps.frames.step();
		t.deps.timers.advance(5000);
		assert.strictEqual(calls(), after, 'nothing called in after the write');
		assert.strictEqual(t.view.get_text(), '');
	});

	test('a hold whose own update poisons leaves no timer, and stops the view', async () => {
		const { load_vt, fail } = counted_load();
		const t = await mount_terminal({ load_vt });
		fail.call = 'ghostty_render_state_update';
		t.view.write(`x${ESC}[?2026h`);
		assert.strictEqual(t.view.get_status().kind, 'poisoned');
		assert.strictEqual(t.deps.timers.pending, 0);
		assert.strictEqual(t.deps.frames.pending, 0);
	});

	test('disposing after poison calls nothing into the module', async () => {
		const { load_vt, calls, fail } = counted_load();
		const t = await mount_terminal({ load_vt });
		t.view.write('x');
		t.step();
		fail.call = 'ghostty_terminal_vt_write';
		t.view.write('y');
		assert.strictEqual(t.view.get_status().kind, 'poisoned');
		const before = calls();
		t.unmount();
		assert.strictEqual(calls(), before);
	});

	test('an ondata that writes its replies back is bounded, reported, and the view goes on', async () => {
		const errors: Array<unknown> = [];
		let replies = 0;
		const t = await mount_terminal({
			measurement: measurement_for(40, 4),
			props: {
				ondata: () => {
					replies++;
					// the host stops echoing on its own, so a regressed bound fails the count below instead of hanging
					if (replies <= 4 * FUZ_TERMINAL_MAX_CALLBACK_WRITES) written_by_host?.write(`${ESC}[6n`);
				},
				onerror: (error) => errors.push(error)
			}
		});
		t.view.write(`${ESC}[6n`);
		assert.strictEqual(replies, FUZ_TERMINAL_MAX_CALLBACK_WRITES + 1);
		assert.strictEqual(errors.length, 1, 'reported once');
		assert.include(String(errors[0]), 'dropped output written from a callback');
		assert.strictEqual(t.view.get_status().kind, 'ready');
		// the next outermost write has a budget of its own
		t.view.write(`ok${ESC}[6n`);
		assert.strictEqual(replies, 2 * (FUZ_TERMINAL_MAX_CALLBACK_WRITES + 1));
		assert.strictEqual(errors.length, 2);
		t.step();
		assert.include(rows_text(t.root)[0], 'ok');
	});
});

describe('an unsized box', () => {
	const UNSIZED = 'its box has no size';
	const warnings = (spy: { mock: { calls: Array<Array<unknown>> } }): number =>
		spy.mock.calls.filter((call) => String(call[0]).includes(UNSIZED)).length;

	test('unmeasurable at ready: one console warning on the first frame, never a status', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const t = await mount_terminal({ measurement: null });
			assert.strictEqual(warnings(warn), 0, 'not before a frame');
			t.step();
			assert.strictEqual(warnings(warn), 1);
			assert.include(String(warn.mock.calls[0]![0]), 'FuzTerminal');
			assert.include(String(warn.mock.calls[0]![0]), 'definite size');
			assert.strictEqual(t.view.get_status().kind, 'ready');
			// still unmeasurable on later frames: no more warnings
			t.deps.fire_resize();
			t.step();
			t.view.write('x');
			t.step();
			assert.strictEqual(warnings(warn), 1);
			// sized, then unsized again: still the one
			t.deps.measurement = measurement_for(10, 3);
			t.deps.fire_resize();
			t.step();
			t.deps.measurement = null;
			t.deps.fire_resize();
			t.step();
			assert.strictEqual(warnings(warn), 1);
		} finally {
			warn.mockRestore();
		}
	});

	test('measurable: no warning', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const t = await mount_terminal();
			t.step();
			t.deps.measurement = null;
			t.deps.fire_resize();
			t.step();
			assert.strictEqual(warnings(warn), 0);
		} finally {
			warn.mockRestore();
		}
	});

	test('unmeasurable at start but sized by the first frame: no warning', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const t = await mount_terminal({ measurement: null });
			t.deps.measurement = measurement_for(10, 3);
			t.step();
			assert.strictEqual(warnings(warn), 0);
		} finally {
			warn.mockRestore();
		}
	});
});

describe('the module as a promise', () => {
	test('loading until it settles; a rejection fails the view with a plain message', async () => {
		let reject!: (error: Error) => void;
		const module = new Promise<WebAssembly.Module>((_, r) => (reject = r));
		const pending = mount_terminal({ props: { module } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		reject(new Error('404 ghostty-vt.wasm'));
		const t = await pending;
		assert.deepEqual(
			t.statuses.map((s) => s.kind),
			['failed']
		);
		assert.strictEqual(
			t.root.querySelector('.message')?.textContent,
			'the terminal failed: 404 ghostty-vt.wasm'
		);
	});

	test('a rejection whose message is no string fails the view with it as a string', async () => {
		const odd = new Error();
		Object.defineProperty(odd, 'message', { value: Symbol('odd') });
		let reject!: (error: Error) => void;
		const module = new Promise<WebAssembly.Module>((_, r) => (reject = r));
		const pending = mount_terminal({ props: { module } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		reject(odd);
		const t = await pending;
		const status = t.view.get_status();
		assert.strictEqual(status.kind, 'failed');
		assert(status.kind === 'failed');
		assert.strictEqual(status.message, 'Symbol(odd)');
		assert.strictEqual(status.error, odd);
		assert.strictEqual(
			t.root.querySelector('.message')?.textContent,
			'the terminal failed: Symbol(odd)'
		);
	});

	test('a promise of the compiled module works like the module', async () => {
		const t = await mount_terminal({ props: { module: compile_test_ghostty_vt() } });
		t.view.write('hi');
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'hi');
	});

	test('unmounted before it settles: nothing is loaded or reported', async () => {
		let resolve!: (module: WebAssembly.Module) => void;
		const module = new Promise<WebAssembly.Module>((r) => (resolve = r));
		let loads = 0;
		const deps = create_test_fuz_terminal_deps(
			() => {
				loads++;
				return load_test_ghostty_vt();
			},
			measurement_for(20, 4)
		);
		const statuses: Array<FuzTerminalStatus> = [];
		const target = document.createElement('div');
		document.body.append(target);
		const mounted = mount(FuzTerminalHarness, {
			target,
			props: { deps, props: { module, onstatus: (s) => statuses.push(s) }, oninstance: () => {} }
		});
		flushSync();
		void unmount(mounted);
		flushSync();
		target.remove();
		resolve(await compile_test_ghostty_vt());
		await new Promise((r) => setTimeout(r, 0));
		assert.strictEqual(loads, 0);
		assert.deepEqual(statuses, []);
	});
});

describe('keyboard input', () => {
	/** Dispatch a keyboard event on `root` as a browser would; returns the event, to read `defaultPrevented`. */
	const press = (
		root: HTMLElement,
		code: string,
		key: string,
		init: KeyboardEventInit & { type?: 'keydown' | 'keyup' } = {}
	): KeyboardEvent => {
		const { type = 'keydown', ...rest } = init;
		const event = new KeyboardEvent(type, {
			code,
			key,
			bubbles: true,
			cancelable: true,
			...rest
		});
		root.dispatchEvent(event);
		return event;
	};

	/** A view recording what reaches `ondata`, decoded. */
	const mount_typing = async (
		options: Parameters<typeof mount_terminal>[0] = {}
	): Promise<Mounted & { sent: Array<string> }> => {
		const sent: Array<string> = [];
		const t = await mount_terminal({
			...options,
			props: { ondata: (data) => sent.push(new TextDecoder().decode(data)), ...options.props }
		});
		return { ...t, sent };
	};

	test('a key the terminal sends is the program’s: its bytes go to ondata, its default is prevented', async () => {
		const t = await mount_typing();
		assert.isTrue(press(t.root, 'KeyA', 'a').defaultPrevented);
		assert.isTrue(press(t.root, 'KeyA', 'A', { shiftKey: true }).defaultPrevented);
		assert.isTrue(press(t.root, 'KeyC', 'c', { ctrlKey: true }).defaultPrevented);
		assert.isTrue(press(t.root, 'Tab', 'Tab').defaultPrevented);
		assert.isTrue(press(t.root, 'KeyW', 'w', { ctrlKey: true }).defaultPrevented);
		assert.isTrue(press(t.root, 'Escape', 'Escape').defaultPrevented);
		assert.isTrue(press(t.root, 'F5', 'F5').defaultPrevented);
		assert.isTrue(press(t.root, 'Enter', 'Enter').defaultPrevented);
		assert.deepEqual(t.sent, ['a', 'A', '\x03', '\t', '\x17', ESC, `${ESC}[15~`, '\r']);
	});

	test('with accepts_input off, keys are neither sent nor prevented; it still draws', async () => {
		const t = await mount_typing({ props: { accepts_input: false } });
		t.root.focus();
		flushSync();
		assert.isFalse(t.root.hasAttribute('data-fuz-terminal-keys'));
		assert.isFalse(is_fuz_terminal_key_target(t.root));
		for (const [code, key] of [
			['KeyA', 'a'],
			['Tab', 'Tab'],
			['Escape', 'Escape'],
			['ArrowUp', 'ArrowUp'],
			['Space', ' ']
		] as const) {
			assert.isFalse(press(t.root, code, key).defaultPrevented, key);
			assert.isFalse(press(t.root, code, key, { type: 'keyup' }).defaultPrevented, key);
		}
		assert.deepEqual(t.sent, []);
		t.view.write('still here');
		t.step();
		assert.strictEqual(rows_text(t.root)[0], 'still here');
		assert.strictEqual(t.view.get_text(), 'still here');
		// focused but not taking keys: drawn as when unfocused
		assert.ok(cursor_element(t.root)?.classList.contains('cursor-block-hollow'));
		// a query is still answered: input off is about keys, not the program's replies
		t.view.write(`${ESC}[6n`);
		assert.deepEqual(t.sent, [`${ESC}[1;11R`]);
	});

	test('a ready view taking keys marks its root for the page’s shortcuts', async () => {
		const t = await mount_typing();
		assert.isTrue(t.root.hasAttribute('data-fuz-terminal-keys'));
		const row = row_elements(t.root)[0]!;
		assert.isTrue(is_fuz_terminal_key_target(row), 'any element inside it');
		assert.isFalse(is_fuz_terminal_key_target(document.body));
		assert.isFalse(is_fuz_terminal_key_target(null));
	});

	test('Ctrl+[ is ESC to a program that asked for no keyboard protocol', async () => {
		const bytes: Array<Array<number>> = [];
		const t = await mount_terminal({ props: { ondata: (data) => bytes.push([...data]) } });
		assert.isTrue(press(t.root, 'BracketLeft', '[', { ctrlKey: true }).defaultPrevented);
		t.view.write(`${ESC}[>1u`);
		press(t.root, 'BracketLeft', '[', { ctrlKey: true });
		assert.deepEqual(bytes, [[0x1b], [...new TextEncoder().encode(`${ESC}[91;5u`)]]);
	});

	test('a modifier alone sends nothing and keeps its default', async () => {
		const t = await mount_typing();
		assert.isFalse(press(t.root, 'ShiftLeft', 'Shift', { shiftKey: true }).defaultPrevented);
		assert.isFalse(press(t.root, 'ControlRight', 'Control', { ctrlKey: true }).defaultPrevented);
		assert.isFalse(press(t.root, 'CapsLock', 'CapsLock').defaultPrevented);
		assert.deepEqual(t.sent, []);
	});

	test('Meta combinations and Ctrl+Shift+C / V are the browser’s and the OS’s', async () => {
		const t = await mount_typing();
		for (const event of [
			press(t.root, 'KeyC', 'c', { metaKey: true }),
			press(t.root, 'KeyV', 'v', { metaKey: true }),
			press(t.root, 'MetaLeft', 'Meta', { metaKey: true }),
			press(t.root, 'KeyC', 'C', { ctrlKey: true, shiftKey: true }),
			press(t.root, 'KeyV', 'V', { ctrlKey: true, shiftKey: true })
		]) {
			assert.isFalse(event.defaultPrevented, event.code);
		}
		assert.deepEqual(t.sent, []);
		// Ctrl+V alone is the program's (a literal-next in a shell)
		assert.isTrue(press(t.root, 'KeyV', 'v', { ctrlKey: true }).defaultPrevented);
		assert.deepEqual(t.sent, ['\x16']);
	});

	test('the browser’s page zoom keys are the browser’s, except on macOS', async () => {
		const t = await mount_typing();
		for (const event of [
			press(t.root, 'Equal', '=', { ctrlKey: true }),
			press(t.root, 'Equal', '+', { ctrlKey: true, shiftKey: true }),
			press(t.root, 'Minus', '-', { ctrlKey: true }),
			press(t.root, 'Minus', '_', { ctrlKey: true, shiftKey: true }),
			press(t.root, 'Digit0', '0', { ctrlKey: true }),
			press(t.root, 'NumpadAdd', '+', { ctrlKey: true }),
			press(t.root, 'NumpadSubtract', '-', { ctrlKey: true }),
			press(t.root, 'Numpad0', '0', { ctrlKey: true })
		]) {
			assert.isFalse(event.defaultPrevented, `${event.code} ${event.key}`);
		}
		assert.deepEqual(t.sent, []);
		// Ctrl+digit stays the program's
		assert.isTrue(press(t.root, 'Digit1', '1', { ctrlKey: true }).defaultPrevented);
		assert.strictEqual(t.sent.length, 1);
		// on macOS the browser zooms with Cmd, so Ctrl+= is the program's
		t.deps.key_platform = 'mac';
		assert.isTrue(press(t.root, 'Equal', '=', { ctrlKey: true }).defaultPrevented);
		assert.strictEqual(t.sent.length, 2);
	});

	test('a composition is left alone; a dead key’s composed character is sent', async () => {
		const t = await mount_typing();
		assert.isFalse(press(t.root, 'KeyA', 'a', { isComposing: true }).defaultPrevented);
		assert.isFalse(press(t.root, 'KeyA', 'Process').defaultPrevented);
		// a dead key, then the key it composes with
		assert.isFalse(press(t.root, 'Quote', 'Dead').defaultPrevented);
		assert.deepEqual(t.sent, []);
		assert.isTrue(press(t.root, 'KeyE', 'é').defaultPrevented);
		assert.deepEqual(t.sent, ['é']);
	});

	test('a mode the program’s output sets changes what an arrow sends', async () => {
		const t = await mount_typing();
		press(t.root, 'ArrowUp', 'ArrowUp');
		t.view.write(`${ESC}[?1h`);
		press(t.root, 'ArrowUp', 'ArrowUp');
		t.view.write(`${ESC}[?1l`);
		press(t.root, 'ArrowUp', 'ArrowUp');
		assert.deepEqual(t.sent, [`${ESC}[A`, `${ESC}OA`, `${ESC}[A`]);
	});

	test('keys and the terminal’s replies share ondata, in order', async () => {
		const t = await mount_typing();
		press(t.root, 'KeyX', 'x');
		t.view.write(`${ESC}[6n`);
		press(t.root, 'KeyY', 'y');
		assert.deepEqual(t.sent, ['x', `${ESC}[1;1R`, 'y']);
	});

	test('an ondata that throws on a key is reported; the key still counts as sent', async () => {
		const errors: Array<unknown> = [];
		let fail = true;
		const sent: Array<string> = [];
		const t = await mount_terminal({
			props: {
				ondata: (data) => {
					if (fail) throw new Error('host broke');
					sent.push(new TextDecoder().decode(data));
				},
				onerror: (error) => errors.push(error)
			}
		});
		assert.isTrue(press(t.root, 'KeyA', 'a').defaultPrevented);
		flushSync();
		assert.strictEqual(errors.length, 1);
		assert.include(String(errors[0]), 'host broke');
		assert.include(t.root.querySelector('.message')?.textContent, 'host broke');
		assert.strictEqual(t.view.get_status().kind, 'ready');
		fail = false;
		press(t.root, 'KeyB', 'b');
		assert.deepEqual(sent, ['b']);
	});

	test('ignored while loading, and after unmount', async () => {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const loading_events: Array<KeyboardEvent> = [];
		const sent: Array<string> = [];
		let calls = 0;
		const t = await mount_terminal({
			props: { ondata: (data) => sent.push(new TextDecoder().decode(data)) },
			load_vt: async () => {
				await gate;
				return load_wrapped_ghostty_vt((exports) => {
					const counted: Record<string, unknown> = {};
					for (const [name, value] of Object.entries(exports)) {
						if (typeof value !== 'function' || !name.startsWith('ghostty_key_')) continue;
						counted[name] = (...args: Array<unknown>): unknown => {
							calls++;
							return value(...args);
						};
					}
					return counted;
				});
			},
			oninstance: (view) => {
				assert.strictEqual(view.get_status().kind, 'loading');
				const root = document.querySelector<HTMLElement>('.fuz-terminal')!;
				loading_events.push(press(root, 'KeyA', 'a'), press(root, 'Enter', 'Enter'));
				open();
			}
		});
		assert.strictEqual(loading_events.length, 2);
		for (const event of loading_events) assert.isFalse(event.defaultPrevented);
		assert.deepEqual(sent, []);
		press(t.root, 'KeyB', 'b');
		assert.deepEqual(sent, ['b']);
		const root = t.root;
		t.unmount();
		const before = calls;
		assert.isFalse(press(root, 'KeyC', 'c').defaultPrevented);
		assert.strictEqual(calls, before);
		assert.deepEqual(sent, ['b']);
	});

	test('ignored once failed', async () => {
		const t = await mount_typing({ load_vt: () => Promise.reject(new Error('no wasm here')) });
		assert.strictEqual(t.view.get_status().kind, 'failed');
		assert.isFalse(press(t.root, 'KeyA', 'a').defaultPrevented);
		assert.deepEqual(t.sent, []);
	});

	test('a library failure while encoding fails the view, and the key keeps its default', async () => {
		const t = await mount_typing({
			load_vt: () =>
				load_wrapped_ghostty_vt(() => ({
					ghostty_key_encoder_encode: () => -2 // GHOSTTY_INVALID_VALUE
				}))
		});
		assert.isFalse(press(t.root, 'KeyA', 'a').defaultPrevented);
		flushSync();
		const status = t.view.get_status();
		assert.strictEqual(status.kind, 'failed');
		assert.include(t.root.querySelector('.message')?.textContent, 'ghostty_key_encoder_encode');
		assert.isFalse(press(t.root, 'KeyB', 'b').defaultPrevented);
		assert.deepEqual(t.sent, []);
	});

	test('an escape while encoding poisons the view without escaping the handler; later keys are ignored', async () => {
		const boom = new Error('trap');
		let fail = false;
		let calls = 0;
		const window_errors: Array<unknown> = [];
		const on_error = (event: ErrorEvent): void => {
			window_errors.push(event.error);
		};
		window.addEventListener('error', on_error);
		cleanups.push(() => window.removeEventListener('error', on_error));
		const t = await mount_typing({
			load_vt: () =>
				load_wrapped_ghostty_vt((exports) => ({
					ghostty_key_encoder_encode: (...args: Array<unknown>): unknown => {
						calls++;
						if (fail) throw boom;
						return exports.ghostty_key_encoder_encode(...args);
					}
				}))
		});
		press(t.root, 'KeyA', 'a');
		fail = true;
		assert.isFalse(press(t.root, 'KeyB', 'b').defaultPrevented);
		flushSync();
		const status = t.view.get_status();
		assert(status.kind === 'poisoned');
		assert.strictEqual(status.error, boom);
		assert.deepEqual(window_errors, []);
		assert.include(t.root.querySelector('.message')?.textContent, 'must be reopened');
		const before = calls;
		assert.isFalse(press(t.root, 'KeyC', 'c').defaultPrevented);
		assert.strictEqual(calls, before);
		assert.deepEqual(t.sent, ['a']);
	});

	test('the platform comes from the deps: on macOS, Option’s text is typed as itself', async () => {
		const t = await mount_typing();
		press(t.root, 'Digit5', '[', { altKey: true });
		t.deps.key_platform = 'mac';
		press(t.root, 'Digit5', '[', { altKey: true });
		press(t.root, 'KeyL', '@', { altKey: true });
		press(t.root, 'ArrowLeft', 'ArrowLeft', { altKey: true });
		assert.deepEqual(t.sent, [`${ESC}[`, '[', '@', `${ESC}[1;3D`]);
	});

	describe('copying on Ctrl+Alt+C and Ctrl+Insert', () => {
		/** Let the clipboard write's promise settle. */
		const settle = async (): Promise<void> => {
			await Promise.resolve();
			await Promise.resolve();
			flushSync();
		};

		test('with a selection in the view: copied, nothing sent, the default prevented', async () => {
			const t = await mount_typing();
			const roots: Array<HTMLElement> = [];
			t.deps.selection = (root) => {
				roots.push(root);
				return 'selected text';
			};
			assert.isTrue(press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true }).defaultPrevented);
			assert.isTrue(press(t.root, 'Insert', 'Insert', { ctrlKey: true }).defaultPrevented);
			assert.deepEqual(t.deps.copied, ['selected text', 'selected text']);
			assert.deepEqual(t.sent, []);
			assert.deepEqual(roots, [t.root, t.root], 'the selection is read against the view’s root');
		});

		test('with no selection in the view: the program’s, as any other key', async () => {
			const t = await mount_typing();
			assert.isTrue(press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true }).defaultPrevented);
			assert.isTrue(press(t.root, 'Insert', 'Insert', { ctrlKey: true }).defaultPrevented);
			assert.deepEqual(t.sent, [`${ESC}\x03`, `${ESC}[2;5~`]);
			assert.deepEqual(t.deps.copied, []);
		});

		test('Ctrl+C is always the program’s, a selection or not', async () => {
			const t = await mount_typing();
			t.deps.selection = 'selected text';
			assert.isTrue(press(t.root, 'KeyC', 'c', { ctrlKey: true }).defaultPrevented);
			assert.deepEqual(t.sent, ['\x03']);
			assert.deepEqual(t.deps.copied, []);
		});

		test('AltGr typing on the C key keeps typing, a selection or not', async () => {
			const t = await mount_typing();
			t.deps.selection = 'selected text';
			const ctrl_alt = { ctrlKey: true, altKey: true };
			press(t.root, 'KeyC', 'ć', { ...ctrl_alt, modifierAltGraph: true });
			// without AltGraph reported, the key the encoder makes of Ctrl+Alt+C, as before
			press(t.root, 'KeyC', 'ć', ctrl_alt);
			assert.deepEqual(t.sent, ['ć', `${ESC}\x03`]);
			assert.deepEqual(t.deps.copied, []);
		});

		test('on macOS the chords are the program’s', async () => {
			const t = await mount_typing();
			t.deps.selection = 'selected text';
			t.deps.key_platform = 'mac';
			assert.isTrue(press(t.root, 'Insert', 'Insert', { ctrlKey: true }).defaultPrevented);
			assert.deepEqual(t.sent, [`${ESC}[2;5~`]);
			assert.deepEqual(t.deps.copied, []);
		});

		test('a copied press sends no release under the Kitty protocol; an uncopied one does', async () => {
			const t = await mount_typing();
			t.view.write(`${ESC}[>3u`);
			t.deps.selection = 'selected text';
			const ctrl_alt = { ctrlKey: true, altKey: true };
			press(t.root, 'KeyC', 'c', ctrl_alt);
			assert.isFalse(press(t.root, 'KeyC', 'c', { ...ctrl_alt, type: 'keyup' }).defaultPrevented);
			press(t.root, 'Insert', 'Insert', { ctrlKey: true });
			assert.isFalse(
				press(t.root, 'Insert', 'Insert', { ctrlKey: true, type: 'keyup' }).defaultPrevented
			);
			assert.deepEqual(t.sent, []);
			assert.strictEqual(t.deps.copied.length, 2);
			t.deps.selection = '';
			press(t.root, 'KeyC', 'c', ctrl_alt);
			assert.isTrue(press(t.root, 'KeyC', 'c', { ...ctrl_alt, type: 'keyup' }).defaultPrevented);
			assert.deepEqual(t.sent, [`${ESC}[99;7u`, `${ESC}[99;7:3u`]);
		});

		test('copies with input off, without sending; with no selection the key keeps its default', async () => {
			const t = await mount_typing({ props: { accepts_input: false } });
			assert.isFalse(press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true }).defaultPrevented);
			t.deps.selection = 'selected text';
			assert.isTrue(press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true }).defaultPrevented);
			assert.deepEqual(t.deps.copied, ['selected text']);
			assert.deepEqual(t.sent, []);
		});

		test('a failed clipboard write is reported, never thrown; the view goes on', async () => {
			const errors: Array<unknown> = [];
			const t = await mount_typing({ props: { onerror: (error) => errors.push(error) } });
			t.deps.selection = 'selected text';
			t.deps.clipboard_error = new Error('write denied');
			assert.isTrue(press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true }).defaultPrevented);
			await settle();
			assert.strictEqual(errors.length, 1);
			assert(errors[0] instanceof Error);
			assert.include(errors[0].message, 'copying the selection to the clipboard failed');
			assert.include(errors[0].message, 'write denied');
			assert.strictEqual(errors[0].cause, t.deps.clipboard_error);
			assert.strictEqual(
				t.root.querySelector('.message')?.textContent,
				'copying the selection to the clipboard failed: write denied'
			);
			assert.strictEqual(t.view.get_status().kind, 'ready');
			assert.deepEqual(t.sent, []);
			press(t.root, 'KeyA', 'a');
			assert.deepEqual(t.sent, ['a']);
		});

		test('a copy that succeeds clears a failed copy’s notice', async () => {
			const t = await mount_typing({ props: { onerror: () => {} } });
			t.deps.selection = 'selected text';
			t.deps.clipboard_error = new Error('write denied');
			press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true });
			await settle();
			assert.isNotNull(t.root.querySelector('.message'));
			t.deps.clipboard_error = undefined;
			press(t.root, 'Insert', 'Insert', { ctrlKey: true });
			await settle();
			assert.isNull(t.root.querySelector('.message'));
			assert.deepEqual(t.deps.copied, ['selected text', 'selected text']);
		});

		test('a copy that succeeds leaves a callback’s notice', async () => {
			const t = await mount_typing({
				props: {
					onbell: () => {
						throw new Error('host bug');
					},
					onerror: () => {}
				}
			});
			t.deps.selection = 'selected text';
			t.deps.clipboard_error = new Error('write denied');
			press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true });
			await settle();
			// a callback's failure after the copy's replaces its notice, and stays
			t.view.write(BEL);
			t.step();
			t.deps.clipboard_error = undefined;
			press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true });
			await settle();
			assert.strictEqual(
				t.root.querySelector('.message')?.textContent,
				'a terminal callback failed: host bug'
			);
		});

		test('without onerror, a failed copy is logged as itself', async () => {
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			cleanups.push(() => error.mockRestore());
			const t = await mount_typing();
			t.deps.selection = 'selected text';
			t.deps.clipboard_error = new Error('write denied');
			press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true });
			await settle();
			assert.strictEqual(error.mock.calls.length, 1);
			assert.strictEqual(
				error.mock.calls[0]![0],
				'[FuzTerminal] copying the selection to the clipboard failed: write denied'
			);
		});

		test('a clipboard write that throws, or a selection read that throws, is reported', async () => {
			const errors: Array<unknown> = [];
			const t = await mount_typing({ props: { onerror: (error) => errors.push(error) } });
			t.deps.selection = 'selected text';
			t.deps.write_clipboard = () => {
				throw new Error('no clipboard');
			};
			assert.isTrue(press(t.root, 'Insert', 'Insert', { ctrlKey: true }).defaultPrevented);
			await settle();
			t.deps.selection = () => {
				throw new Error('no selection');
			};
			// unreadable: the key is the program's
			assert.isTrue(press(t.root, 'Insert', 'Insert', { ctrlKey: true }).defaultPrevented);
			assert.deepEqual(t.sent, [`${ESC}[2;5~`]);
			assert.deepEqual(
				errors.map((error) => String(error)),
				[
					'Error: copying the selection to the clipboard failed: no clipboard',
					'Error: copying the selection to the clipboard failed: no selection'
				]
			);
		});

		test('a write that fails after unmount reports nothing; once unmounted, nothing copies', async () => {
			const errors: Array<unknown> = [];
			const t = await mount_typing({ props: { onerror: (error) => errors.push(error) } });
			t.deps.selection = 'selected text';
			t.deps.clipboard_error = new Error('late');
			press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true });
			t.unmount();
			await settle();
			assert.deepEqual(errors, []);
			assert.deepEqual(t.deps.copied, ['selected text']);
			assert.isFalse(press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true }).defaultPrevented);
			assert.strictEqual(t.deps.copied.length, 1);
		});

		test('a state not yet attached to its root copies nothing', async () => {
			const deps = create_test_fuz_terminal_deps(() => load_test_ghostty_vt());
			deps.selection = 'selected text';
			const state = new FuzTerminalState(() => ({ module: compile_test_ghostty_vt() }), deps);
			const event = new KeyboardEvent('keydown', {
				code: 'KeyC',
				key: 'c',
				ctrlKey: true,
				altKey: true
			});
			assert.isFalse(state.handle_key(event, 'keydown'));
			assert.deepEqual(deps.copied, []);
			state.destroy();
		});

		test('a chord in a composition is the composition’s', async () => {
			const t = await mount_typing();
			t.deps.selection = 'selected text';
			const event = press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true, isComposing: true });
			assert.isFalse(event.defaultPrevented);
			assert.deepEqual(t.deps.copied, []);
			assert.deepEqual(t.sent, []);
		});

		test('copies in a failed view', async () => {
			const t = await mount_typing({ load_vt: () => Promise.reject(new Error('no module')) });
			assert.strictEqual(t.view.get_status().kind, 'failed');
			t.deps.selection = 'selected text';
			assert.isTrue(press(t.root, 'KeyC', 'c', { ctrlKey: true, altKey: true }).defaultPrevented);
			assert.deepEqual(t.deps.copied, ['selected text']);
			assert.deepEqual(t.sent, []);
		});

		test('copies in a poisoned view, which keeps its last frame', async () => {
			const fail = { on: false };
			const t = await mount_typing({
				load_vt: () =>
					load_wrapped_ghostty_vt((exports) => ({
						ghostty_render_state_update: (...args: Array<unknown>) => {
							if (fail.on) throw new Error('trap');
							return exports.ghostty_render_state_update(...args);
						}
					}))
			});
			t.view.write('before');
			t.step();
			fail.on = true;
			t.view.write(' after');
			t.step();
			assert.strictEqual(t.view.get_status().kind, 'poisoned');
			assert.strictEqual(rows_text(t.root)[0], 'before');
			t.deps.selection = 'before';
			assert.isTrue(press(t.root, 'Insert', 'Insert', { ctrlKey: true }).defaultPrevented);
			assert.deepEqual(t.deps.copied, ['before']);
			assert.deepEqual(t.sent, []);
		});

		test('the numpad’s Insert, NumLock off, is a copy chord too', async () => {
			const t = await mount_typing();
			assert.isTrue(press(t.root, 'Numpad0', 'Insert', { ctrlKey: true }).defaultPrevented);
			assert.deepEqual(t.sent, [`${ESC}[2;5~`]);
			t.deps.selection = 'selected text';
			assert.isTrue(press(t.root, 'Numpad0', 'Insert', { ctrlKey: true }).defaultPrevented);
			assert.deepEqual(t.deps.copied, ['selected text']);
			assert.deepEqual(t.sent, [`${ESC}[2;5~`]);
		});

		describe('the browser’s selection', () => {
			const select = (
				start: Node,
				start_offset: number,
				end: Node,
				end_offset: number
			): Selection => {
				const selection = document.getSelection()!;
				const range = document.createRange();
				range.setStart(start, start_offset);
				range.setEnd(end, end_offset);
				selection.removeAllRanges();
				selection.addRange(range);
				return selection;
			};
			afterEach(() => document.getSelection()?.removeAllRanges());

			/** A view showing two rows of text, after a paragraph outside it. */
			const mount_text = async (): Promise<Mounted & { outside: HTMLElement }> => {
				const t = await mount_typing();
				const outside = document.createElement('p');
				outside.textContent = 'outside';
				t.target.before(outside);
				cleanups.push(() => outside.remove());
				t.view.write('hello\r\nworld');
				t.step();
				return { ...t, outside };
			};

			test('a selection inside the rows is the selection’s text', async () => {
				const t = await mount_text();
				const [first, second] = row_elements(t.root);
				const selection = select(first!, 0, second!, second!.childNodes.length);
				assert.strictEqual(
					get_fuz_terminal_selection_text(selection, t.root),
					selection.toString()
				);
				assert.include(selection.toString(), 'hello');
				assert.include(selection.toString(), 'world');
				// the browser's deps read the document's selection
				assert.strictEqual(create_fuz_terminal_deps().read_selection(t.root), selection.toString());
			});

			test('one reaching in from outside is the whole selection’s text', async () => {
				const t = await mount_text();
				const first = row_elements(t.root)[0]!;
				const selection = select(t.outside.firstChild!, 0, first, first.childNodes.length);
				const text = get_fuz_terminal_selection_text(selection, t.root);
				assert.include(text, 'outside');
				assert.include(text, 'hello');
			});

			test('one outside the view, a collapsed one, or none is empty', async () => {
				const t = await mount_text();
				const text = t.outside.firstChild!;
				assert.strictEqual(get_fuz_terminal_selection_text(select(text, 0, text, 3), t.root), '');
				const first = row_elements(t.root)[0]!;
				assert.strictEqual(get_fuz_terminal_selection_text(select(first, 0, first, 0), t.root), '');
				assert.strictEqual(get_fuz_terminal_selection_text(null, t.root), '');
				document.getSelection()!.removeAllRanges();
				assert.strictEqual(create_fuz_terminal_deps().read_selection(t.root), '');
			});

			test('one that only touches the view’s edge is empty', async () => {
				const t = await mount_text();
				const text = t.outside.firstChild!;
				const first = row_elements(t.root)[0]!;
				// a triple-click's range ends at the start of the next block
				for (const [end, offset] of [
					[t.root, 0],
					[first, 0]
				] as const) {
					assert.strictEqual(
						get_fuz_terminal_selection_text(select(text, 0, end, offset), t.root),
						''
					);
				}
				// and one from the view's end into a block after it
				const after = document.createElement('p');
				after.textContent = 'after';
				t.target.after(after);
				cleanups.push(() => after.remove());
				assert.strictEqual(
					get_fuz_terminal_selection_text(
						select(t.root, t.root.childNodes.length, after.firstChild!, 3),
						t.root
					),
					''
				);
				// or from the rows' end, past the cursor and the probe, into it
				const last = row_elements(t.root)[1]!.querySelector('.run:last-of-type')!
					.firstChild as Text;
				assert.strictEqual(
					get_fuz_terminal_selection_text(select(last, last.length, after.firstChild!, 3), t.root),
					''
				);
				// with the focused block cursor over the last character, its copy of it
				// takes nothing either
				t.view.write('\x1b[D');
				t.root.focus();
				t.step();
				assert.strictEqual(t.root.querySelector('.cursor')!.textContent, 'd');
				const before_cursor = row_elements(t.root)[1]!.querySelector('.run:last-of-type')!
					.firstChild as Text;
				assert.strictEqual(
					get_fuz_terminal_selection_text(
						select(before_cursor, before_cursor.length, after.firstChild!, 3),
						t.root
					),
					''
				);
				// one ending past the view's start takes some of it
				const selection = select(text, 0, first, first.childNodes.length);
				assert.strictEqual(
					get_fuz_terminal_selection_text(selection, t.root),
					selection.toString()
				);
			});

			test('the browser’s clipboard write is navigator.clipboard’s, rejecting without it', async () => {
				const written: Array<string> = [];
				Object.defineProperty(navigator, 'clipboard', {
					configurable: true,
					value: {
						writeText: (text: string) => {
							written.push(text);
							return Promise.resolve();
						}
					}
				});
				cleanups.push(() => Reflect.deleteProperty(navigator, 'clipboard'));
				await create_fuz_terminal_deps().write_clipboard('copied');
				assert.deepEqual(written, ['copied']);
				Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
				const error = await create_fuz_terminal_deps()
					.write_clipboard('x')
					.then(
						() => null,
						(e: unknown) => e
					);
				assert(error instanceof Error);
				assert.include(error.message, 'secure context');
			});
		});
	});

	describe('the Kitty keyboard protocol', () => {
		test('the terminal reports it to a program that asks, and encodes as it asks', async () => {
			const t = await mount_typing();
			t.view.write(`${ESC}[?u`);
			assert.deepEqual(t.sent, [`${ESC}[?0u`]);
			t.view.write(`${ESC}[>1u${ESC}[?u`);
			assert.deepEqual(t.sent, [`${ESC}[?0u`, `${ESC}[?1u`]);
			press(t.root, 'Escape', 'Escape');
			press(t.root, 'KeyC', 'c', { ctrlKey: true });
			press(t.root, 'KeyA', 'A', { shiftKey: true });
			assert.deepEqual(t.sent.slice(2), [`${ESC}[27u`, `${ESC}[99;5u`, 'A']);
		});

		test('releases reach the program only while it has event reporting on', async () => {
			const t = await mount_typing();
			press(t.root, 'KeyA', 'a');
			assert.isFalse(press(t.root, 'KeyA', 'a', { type: 'keyup' }).defaultPrevented);
			assert.deepEqual(t.sent, ['a']);
			t.view.write(`${ESC}[>3u`);
			press(t.root, 'KeyA', 'a');
			assert.isTrue(press(t.root, 'KeyA', 'a', { type: 'keyup' }).defaultPrevented);
			press(t.root, 'Escape', 'Escape');
			press(t.root, 'Escape', 'Escape', { repeat: true });
			press(t.root, 'Escape', 'Escape', { type: 'keyup' });
			assert.deepEqual(t.sent, [
				'a',
				'a',
				`${ESC}[97;1:3u`,
				`${ESC}[27u`,
				`${ESC}[27;1:2u`,
				`${ESC}[27;1:3u`
			]);
			// the program turns it off: releases are left alone again
			t.view.write(`${ESC}[<u`);
			press(t.root, 'KeyB', 'b');
			assert.isFalse(press(t.root, 'KeyB', 'b', { type: 'keyup' }).defaultPrevented);
			assert.deepEqual(t.sent.slice(6), ['b']);
		});

		test('a taken press’s release is sent whatever the modifiers are by then, once', async () => {
			const t = await mount_typing();
			t.view.write(`${ESC}[>3u`);
			// Meta added while A is held: the release isn't the browser's
			press(t.root, 'KeyA', 'a');
			assert.isTrue(press(t.root, 'KeyA', 'a', { type: 'keyup', metaKey: true }).defaultPrevented);
			// Ctrl+C held, Shift added: a Ctrl+Shift+C keyup, still the program's
			press(t.root, 'KeyC', 'c', { ctrlKey: true });
			press(t.root, 'KeyC', 'C', { type: 'keyup', ctrlKey: true, shiftKey: true });
			// a composition starting while a key is held
			press(t.root, 'KeyB', 'b');
			press(t.root, 'KeyB', 'b', { type: 'keyup', isComposing: true });
			assert.deepEqual(t.sent, [
				'a',
				`${ESC}[97;9:3u`,
				`${ESC}[99;5u`,
				`${ESC}[99;6:3u`,
				'b',
				`${ESC}[98;1:3u`
			]);
			// each forgotten once released: a second keyup sends nothing
			assert.isFalse(press(t.root, 'KeyA', 'a', { type: 'keyup' }).defaultPrevented);
			assert.isFalse(press(t.root, 'KeyC', 'c', { type: 'keyup' }).defaultPrevented);
			assert.strictEqual(t.sent.length, 6);
		});

		test('no release for a key whose press the program didn’t get', async () => {
			const t = await mount_typing();
			t.view.write(`${ESC}[>3u`);
			// pressed before the view had focus, passed through, or composed
			assert.isFalse(press(t.root, 'KeyQ', 'q', { type: 'keyup' }).defaultPrevented);
			press(t.root, 'KeyC', 'C', { ctrlKey: true, shiftKey: true });
			press(t.root, 'KeyC', 'C', { ctrlKey: true, shiftKey: true, type: 'keyup' });
			press(t.root, 'KeyC', 'c', { type: 'keyup' });
			press(t.root, 'Equal', '=', { ctrlKey: true });
			press(t.root, 'Equal', '=', { ctrlKey: true, type: 'keyup' });
			press(t.root, 'Quote', 'Dead');
			press(t.root, 'Quote', "'", { type: 'keyup' });
			assert.deepEqual(t.sent, []);
			// held when focus left: its release went elsewhere
			press(t.root, 'KeyA', 'a');
			t.root.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
			press(t.root, 'KeyA', 'a', { type: 'keyup' });
			assert.deepEqual(t.sent, ['a']);
		});
	});
});

describe('pasting', () => {
	const mount_pasting = async (
		options: Parameters<typeof mount_terminal>[0] = {}
	): Promise<Mounted & { sent: Array<string> }> => {
		const sent: Array<string> = [];
		const t = await mount_terminal({
			...options,
			props: { ondata: (data) => sent.push(new TextDecoder().decode(data)), ...options.props }
		});
		return { ...t, sent };
	};

	test('the text goes to ondata in one call, framed once the program asks for bracketed paste', async () => {
		const t = await mount_pasting();
		assert.deepEqual(t.view.paste('ls -la'), { kind: 'pasted', length: 6 });
		t.view.write(`${ESC}[?2004h`);
		assert.deepEqual(t.view.paste('a\nb'), { kind: 'pasted', length: 15 });
		assert.deepEqual(t.sent, ['ls -la', `${ESC}[200~a\nb${ESC}[201~`]);
		// the screen is the program's to change: a paste draws nothing itself
		t.step();
		assert.deepEqual(rows_text(t.root), ['', '', '', '']);
	});

	test('unsafe text is refused unless its risk is allowed, and sends nothing', async () => {
		const t = await mount_pasting();
		const line_break = { hazard: 'line_break', bracketed: false } as const;
		assert.deepEqual(t.view.paste('rm -rf ~\n'), { kind: 'rejected', ...line_break });
		assert.deepEqual(t.view.paste(`x${ESC}[201~`), {
			kind: 'rejected',
			hazard: 'paste_end',
			bracketed: false
		});
		assert.deepEqual(t.sent, []);
		assert.deepEqual(t.view.paste('a\nb', { allow_unsafe: line_break }), {
			kind: 'pasted',
			length: 3
		});
		assert.deepEqual(t.sent, ['a\rb']);
		// allowing one risk allows no other
		assert.deepEqual(t.view.paste(`x${ESC}[201~`, { allow_unsafe: line_break }), {
			kind: 'rejected',
			hazard: 'paste_end',
			bracketed: false
		});
		t.view.write(`${ESC}[?2004h`);
		assert.deepEqual(
			t.view.paste(`x${ESC}[201~`, { allow_unsafe: { hazard: 'paste_end', bracketed: false } }),
			{ kind: 'rejected', hazard: 'paste_end', bracketed: true }
		);
		assert.deepEqual(t.sent, ['a\rb']);
	});

	test('a paste too large is reported so before its safety, so it is never asked about', async () => {
		const t = await mount_pasting();
		assert.deepEqual(t.view.paste('a\nb', { max_length: 2 }), { kind: 'too_large', length: 3 });
		assert.deepEqual(t.view.paste('a\nb', { max_length: 3 }), {
			kind: 'rejected',
			hazard: 'line_break',
			bracketed: false
		});
		t.view.write(`${ESC}[?2004h`);
		// bracketed, the end sequence is the hazard and the frame counts
		const text = `ok${ESC}[201~`;
		assert.deepEqual(t.view.paste(text, { max_length: text.length + 11 }), {
			kind: 'too_large',
			length: text.length + 12
		});
		assert.deepEqual(t.view.paste(text, { max_length: text.length + 12 }), {
			kind: 'rejected',
			hazard: 'paste_end',
			bracketed: true
		});
		assert.deepEqual(t.sent, []);
	});

	test('empty text sends nothing', async () => {
		const t = await mount_pasting();
		assert.deepEqual(t.view.paste(''), { kind: 'empty' });
		assert.deepEqual(t.sent, []);
	});

	test('past max_length nothing is sent; the framing and multi-byte text are measured as characters', async () => {
		const t = await mount_pasting();
		// 你 is one UTF-16 code unit and three bytes: measured as one
		assert.deepEqual(t.view.paste('你好', { max_length: 2 }), { kind: 'pasted', length: 2 });
		assert.deepEqual(t.view.paste('abc', { max_length: 2 }), { kind: 'too_large', length: 3 });
		t.view.write(`${ESC}[?2004h`);
		// the frame's 12 characters count
		assert.deepEqual(t.view.paste('abc', { max_length: 14 }), { kind: 'too_large', length: 15 });
		assert.deepEqual(t.view.paste('abc', { max_length: 15 }), { kind: 'pasted', length: 15 });
		assert.deepEqual(t.sent, ['你好', `${ESC}[200~abc${ESC}[201~`]);
	});

	test('unavailable with input off, while loading, once failed, and from a callback inside a write', async () => {
		const off = await mount_pasting({ props: { accepts_input: false } });
		assert.deepEqual(off.view.paste('x'), { kind: 'unavailable', reason: 'input_off' });
		assert.deepEqual(off.sent, []);
		off.unmount();

		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const while_loading: Array<unknown> = [];
		const loading = await mount_pasting({
			load_vt: async () => {
				await gate;
				return load_test_ghostty_vt();
			},
			oninstance: (view) => {
				while_loading.push(
					view.paste('x', { allow_unsafe: { hazard: 'line_break', bracketed: false } })
				);
				open();
			}
		});
		assert.deepEqual(while_loading, [{ kind: 'unavailable', reason: 'not_ready' }]);
		assert.deepEqual(loading.sent, []);
		loading.unmount();
		assert.deepEqual(loading.view.paste('x'), { kind: 'unavailable', reason: 'not_ready' });

		const failed = await mount_pasting({
			load_vt: () => Promise.reject(new Error('no wasm here'))
		});
		assert.deepEqual(failed.view.paste('x'), { kind: 'unavailable', reason: 'not_ready' });

		// a bell in a replay and in live output: neither callback's paste is sent
		const from_callback: Array<unknown> = [];
		const busy = await mount_pasting({
			props: {
				ontitle: () => from_callback.push(written_by_host!.paste('from title')),
				onbell: () => from_callback.push(written_by_host!.paste('from bell'))
			}
		});
		busy.view.write(`${ESC}]2;replayed${BEL}`, { replay: true });
		busy.view.write(`${ESC}]2;live${BEL}\x07`);
		assert.deepEqual(from_callback, [
			{ kind: 'unavailable', reason: 'busy' },
			{ kind: 'unavailable', reason: 'busy' },
			{ kind: 'unavailable', reason: 'busy' }
		]);
		assert.deepEqual(busy.sent, []);
	});

	test('a library failure while encoding fails the view, sending nothing', async () => {
		const t = await mount_pasting({
			load_vt: () =>
				load_wrapped_ghostty_vt(() => ({
					ghostty_paste_encode: () => -2 // GHOSTTY_INVALID_VALUE
				}))
		});
		assert.deepEqual(t.view.paste('x'), { kind: 'unavailable', reason: 'not_ready' });
		flushSync();
		assert.strictEqual(t.view.get_status().kind, 'failed');
		assert.include(t.root.querySelector('.message')?.textContent, 'ghostty_paste_encode');
		assert.deepEqual(t.sent, []);
	});

	test('an ondata that throws is reported; the paste still counts as sent', async () => {
		const errors: Array<unknown> = [];
		const t = await mount_pasting({
			props: {
				ondata: () => {
					throw new Error('host broke');
				},
				onerror: (error) => errors.push(error)
			}
		});
		assert.deepEqual(t.view.paste('x'), { kind: 'pasted', length: 1 });
		assert.strictEqual(errors.length, 1);
		assert.strictEqual(t.view.get_status().kind, 'ready');
	});
});
