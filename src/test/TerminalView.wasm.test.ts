// @vitest-environment jsdom

import { test, describe, beforeEach, afterEach, assert, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { create_uuid, type Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { Frontend } from '#lib/frontend.svelte.ts';
import type { GhosttyVt } from '#lib/fuz_terminal/ghostty_vt.ts';
import type { Terminal } from '#lib/terminal.svelte.ts';
import { TERMINAL_ACK_DELAY } from '#lib/terminal_helpers.ts';

import TerminalViewHarness from './TerminalViewHarness.svelte';
import {
	create_test_fuz_terminal_deps,
	measurement_for,
	type TestFuzTerminalDeps
} from './fuz_terminal/fuz_terminal_test_helpers.ts';
import {
	compile_test_ghostty_vt,
	load_test_ghostty_vt,
	load_wrapped_ghostty_vt
} from './fuz_terminal/ghostty_vt_test_helpers.ts';
import { monkeypatch_zzz_for_tests } from './test_helpers.ts';
import { handle_dashboard_shortcut } from '#lib/dashboard_shortcuts.ts';
import {
	calls_of,
	flush,
	result_ok,
	stub_terminal_api,
	type StubbedTerminalCall
} from './terminal_test_helpers.ts';

const ESC = '\x1b';
/** A cursor position report request, which a live view answers with `ESC [ row ; col R`. */
const CPR = `${ESC}[6n`;

let app: Frontend;
let calls: Array<StubbedTerminalCall>;
const cleanups: Array<() => void> = [];

beforeEach(() => {
	// only timeouts: the module compiles and instantiates on the real event loop
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	app = monkeypatch_zzz_for_tests(new Frontend());
	calls = stub_terminal_api(app);
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.useRealTimers();
});

/** A running terminal, the ack of 0 its start announces answered and dropped from `calls`. */
const create_running = (terminal_id: Uuid = create_uuid()): Terminal => {
	const terminal = app.terminals.add({ command: 'sh' });
	terminal.start(terminal_id);
	const announce = calls_of(calls, 'terminal_ack');
	assert.deepEqual(
		announce.map((c) => c.input),
		[{ terminal_id, bytes: 0 }],
		'the start announces 0'
	);
	calls.splice(calls.indexOf(announce[0]!), 1);
	announce[0]!.resolve(result_ok());
	return terminal;
};

/** Let the event loop run: the module's compile and instantiate settle on it. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface MountedView {
	deps: TestFuzTerminalDeps;
	target: HTMLElement;
	/** The text getter the view handed its parent. */
	get_text: () => string;
	/** How many emulator instances the views have loaded. */
	readonly loads: number;
	/** Run the pending frames and flush the DOM. */
	step: () => void;
	unmount: () => void;
}

const mount_view = (
	terminal: Terminal,
	options: {
		load_module?: () => Promise<WebAssembly.Module>;
		load_vt?: (module: WebAssembly.Module) => Promise<GhosttyVt>;
	} = {}
): MountedView => {
	let loads = 0;
	const load_vt = options.load_vt ?? (() => load_test_ghostty_vt());
	const deps = create_test_fuz_terminal_deps(
		(module) => {
			loads++;
			return load_vt(module);
		},
		measurement_for(20, 4)
	);
	let get_text: (() => string) | null = null;
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(TerminalViewHarness, {
		target,
		props: {
			deps,
			terminal,
			load_module: options.load_module ?? compile_test_ghostty_vt,
			get_text: (fn: () => string) => (get_text = fn)
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
	return {
		deps,
		target,
		get_text: () => get_text?.() ?? '',
		get loads() {
			return loads;
		},
		step: () => {
			deps.frames.step();
			flushSync();
		},
		unmount: do_unmount
	};
};

/** Wait until the view's emulator has left `loading`, by its copy button or its message. */
const settle = async (view: MountedView): Promise<void> => {
	for (let i = 0; i < 100; i++) {
		await tick();
		flushSync();
		const copy = view.target.querySelector<HTMLButtonElement>('.terminal-actions button');
		if (view.target.querySelector('.fuz-terminal .message') || (copy && !copy.disabled)) return;
	}
	assert.fail('the view never left loading');
};

const message_text = (view: MountedView): string =>
	view.target.querySelector('.fuz-terminal .message')?.textContent ?? '';

const rows_text = (view: MountedView): Array<string> =>
	Array.from(view.target.querySelectorAll('.fuz-terminal-row')).map((row) => row.textContent);

/** The input sent to the PTY so far, answering each send so the next goes out. */
const sent_input = async (): Promise<string> => {
	let input = '';
	for (let i = 0; i < 5; i++) {
		await flush();
		for (const call of calls_of(calls, 'terminal_data_send')) {
			if (calls.includes(call)) {
				input += call.input.data;
				calls.splice(calls.indexOf(call), 1);
				call.resolve(result_ok());
			}
		}
	}
	return input;
};

/** The `bytes` of every ack sent once the ack delay has run out, each answered. */
const acked = async (): Promise<Array<number>> => {
	await vi.advanceTimersByTimeAsync(TERMINAL_ACK_DELAY);
	const acks = calls_of(calls, 'terminal_ack');
	for (const call of acks) {
		calls.splice(calls.indexOf(call), 1);
		call.resolve(result_ok());
	}
	await flush();
	return acks.map((c) => c.input.bytes);
};

describe('TerminalView output', () => {
	test('replays the history without answering its queries, then answers live ones', async () => {
		const terminal = create_running();
		terminal.receive_output(`${CPR}before\r\n`, 12);
		const view = mount_view(terminal);
		await settle(view);
		view.step();
		assert.strictEqual(view.get_text(), 'before');
		assert.strictEqual(await sent_input(), '', 'the replayed query got no answer');

		terminal.receive_output(`after${CPR}`, 22);
		assert.strictEqual(await sent_input(), `${ESC}[2;6R`, 'the live query is answered');
		view.step();
		assert.strictEqual(view.get_text(), 'before\nafter');
	});

	test('replays the truncated notice ahead of a history that lost output', async () => {
		const terminal = create_running();
		terminal.receive_output('kept', 4);
		terminal.output.mark_dropped();
		const view = mount_view(terminal);
		await settle(view);
		assert.strictEqual(view.get_text(), '[earlier output truncated]\nkept');
	});

	test('acks a chunk handed over while loading only once the view is ready', async () => {
		const terminal = create_running();
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const view = mount_view(terminal, {
			load_module: async () => {
				await held;
				return compile_test_ghostty_vt();
			}
		});
		await tick();
		terminal.receive_output('a', 1);
		terminal.receive_output(`b${CPR}`, 6);
		assert.deepEqual(await acked(), [], 'queued unparsed: not consumed');
		release();
		await settle(view);
		assert.deepEqual(await acked(), [6], 'consumed in order once parsed');
		// a query that arrived while loading is answered live once ready
		assert.strictEqual(await sent_input(), `${ESC}[1;3R`);
		terminal.receive_output('c', 7);
		assert.deepEqual(await acked(), [7]);
		assert.strictEqual(view.get_text(), 'abc');
	});

	test('the view resizes the PTY to its size', async () => {
		const terminal_id = create_uuid();
		const terminal = create_running(terminal_id);
		const view = mount_view(terminal);
		await settle(view);
		await flush();
		assert.deepEqual(
			calls_of(calls, 'terminal_resize').map((c) => c.input),
			[{ terminal_id, cols: 20, rows: 4 }]
		);
	});

	test('keys go to the PTY as input', async () => {
		const terminal = create_running();
		const view = mount_view(terminal);
		await settle(view);
		const root = view.target.querySelector<HTMLElement>('.fuz-terminal')!;
		root.focus();
		root.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'é', code: 'KeyE', bubbles: true, cancelable: true })
		);
		root.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
		);
		assert.strictEqual(await sent_input(), 'é\r');
	});

	test('after unmount the terminal acks without the view', async () => {
		const terminal = create_running();
		const view = mount_view(terminal);
		await settle(view);
		view.unmount();
		terminal.receive_output('later', 5);
		assert.deepEqual(await acked(), [5]);
	});

	test('a combining mark in its own chunk is drawn: grapheme clustering is on', async () => {
		const terminal = create_running();
		const view = mount_view(terminal);
		await settle(view);
		terminal.receive_output('cafe', 4);
		view.step();
		assert.strictEqual(rows_text(view)[0], 'cafe');
		terminal.receive_output('́', 6);
		view.step();
		assert.strictEqual(rows_text(view)[0], 'café');
		// an emoji ZWJ sequence is one wide cell
		terminal.receive_output('\r\n👨‍👩‍👧!', 30);
		view.step();
		const runs = Array.from(
			view.target.querySelectorAll<HTMLElement>('.fuz-terminal-row')
		)[1]!.querySelectorAll<HTMLElement>('.run');
		assert.deepEqual(
			Array.from(runs).map((r) => [r.textContent, r.style.getPropertyValue('--run_width')]),
			[
				['👨‍👩‍👧', '2'],
				['!', '1']
			]
		);
	});
});

describe('TerminalView failures', () => {
	test('a missing module shows how to build it, acks every chunk, and retries', async () => {
		const terminal = create_running();
		terminal.receive_output('history', 7);
		assert.deepEqual(await acked(), [7], 'buffered with no view: acked');
		let built = false;
		let reject!: (error: Error) => void;
		const view = mount_view(terminal, {
			load_module: () =>
				built ? compile_test_ghostty_vt() : new Promise((_resolve, rej) => (reject = rej))
		});
		await tick();
		terminal.receive_output('-more', 12);
		assert.deepEqual(await acked(), [], 'waiting while the load is in flight');
		reject(
			new Error(
				"the terminal emulator module isn't available — build it with `cargo xtask ghostty-vt`"
			)
		);
		await settle(view);
		assert.include(message_text(view), 'cargo xtask ghostty-vt');
		assert.strictEqual(view.loads, 0);
		assert.deepEqual(await acked(), [12], 'released by the failure');
		terminal.receive_output('-again', 18);
		assert.deepEqual(await acked(), [18]);
		assert.isNull(
			view.target.querySelector('.terminal-actions button[title="reopen the terminal view"]')
		);
		const retry = view.target.querySelector<HTMLButtonElement>(
			'.terminal-actions button[title="retry loading the terminal view"]'
		);
		assert.ok(retry, 'a failed load offers a retry');
		assert.strictEqual(retry.textContent.trim(), 'retry');
		// the module gets built; retrying loads it without a page reload
		built = true;
		retry.click();
		flushSync();
		await settle(view);
		assert.strictEqual(message_text(view), '');
		assert.strictEqual(view.loads, 1);
		assert.strictEqual(view.get_text(), 'history-more-again');
		assert.isNull(
			view.target.querySelector('.terminal-actions button[title="retry loading the terminal view"]')
		);
	});

	test('a poisoned view acks what it is handed, and reopening replays into a fresh one', async () => {
		const poison = { on: false };
		let instances = 0;
		const terminal = create_running();
		terminal.receive_output('one\r\n', 5);
		const view = mount_view(terminal, {
			load_vt: () => {
				instances++;
				return instances === 1
					? load_wrapped_ghostty_vt((exports) => ({
							ghostty_terminal_vt_write: (...args: Array<unknown>) => {
								if (poison.on) throw new Error('trap');
								return exports.ghostty_terminal_vt_write(...args);
							}
						}))
					: load_test_ghostty_vt();
			}
		});
		await settle(view);
		poison.on = true;
		terminal.receive_output('two\r\n', 10);
		flushSync();
		assert.include(message_text(view), 'must be reopened');
		terminal.receive_output('three\r\n', 17);
		assert.deepEqual(await acked(), [17], 'consumed while poisoned');

		const reopen = view.target.querySelector<HTMLButtonElement>(
			'.terminal-actions button[title="reopen the terminal view"]'
		);
		assert.ok(reopen, 'a poisoned view offers to reopen');
		reopen.click();
		flushSync();
		await settle(view);
		assert.strictEqual(view.loads, 2);
		assert.strictEqual(message_text(view), '');
		assert.strictEqual(view.get_text(), 'one\ntwo\nthree', 'the history replayed into the new one');
		assert.isNull(
			view.target.querySelector('.terminal-actions button[title="reopen the terminal view"]')
		);
		terminal.receive_output('four', 21);
		assert.deepEqual(await acked(), [21]);
		assert.strictEqual(view.get_text(), 'one\ntwo\nthree\nfour');
	});

	test('a restarted process gets a fresh emulator', async () => {
		const terminal = create_running();
		const view = mount_view(terminal);
		await settle(view);
		terminal.receive_output('old run', 7);
		assert.strictEqual(view.get_text(), 'old run');
		terminal.reset();
		flushSync();
		terminal.start(create_uuid());
		await settle(view);
		assert.strictEqual(view.loads, 2);
		assert.strictEqual(view.get_text(), '');
		terminal.receive_output('new run', 7);
		assert.strictEqual(view.get_text(), 'new run');
	});
});

const key = (root: HTMLElement, init: KeyboardEventInit): KeyboardEvent => {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	root.dispatchEvent(event);
	return event;
};

const terminal_root = (view: MountedView): HTMLElement =>
	view.target.querySelector<HTMLElement>('.fuz-terminal')!;

describe('TerminalView input', () => {
	test('a terminal whose process ended takes no keys, and leaves them to the browser', async () => {
		const terminal = create_running();
		const view = mount_view(terminal);
		await settle(view);
		terminal.receive_output('done', 4);
		view.step();
		const root = terminal_root(view);
		root.focus();
		flushSync();
		assert.ok(root.hasAttribute('data-fuz-terminal-keys'), 'taking keys while running');
		assert.ok(
			view.target.querySelector('.cursor-block'),
			'a focused, running terminal draws a solid cursor'
		);
		terminal.receive_exited(0);
		flushSync();
		view.step();
		assert.isFalse(root.hasAttribute('data-fuz-terminal-keys'));
		for (const init of [
			{ key: 'Tab', code: 'Tab' },
			{ key: 'ArrowUp', code: 'ArrowUp' },
			{ key: 'PageDown', code: 'PageDown' },
			{ key: ' ', code: 'Space' },
			{ key: 'a', code: 'KeyA' }
		]) {
			assert.isFalse(key(root, init).defaultPrevented, `${init.key} keeps its default`);
		}
		assert.strictEqual(await sent_input(), '');
		assert.isNull(view.target.querySelector('.cursor-block'), 'the cursor is hollow');
		assert.ok(view.target.querySelector('.cursor-block-hollow'));
		assert.strictEqual(view.get_text(), 'done', 'it still draws and copies');
	});
});

describe('the dashboard shortcuts around a terminal', () => {
	/** The dashboard's real handler, on `window` in the capture phase as `Dashboard` installs it. */
	const install_shortcuts = (): void => {
		const handler = (e: KeyboardEvent): void => void handle_dashboard_shortcut(e, app.ui);
		window.addEventListener('keydown', handler, { capture: true });
		cleanups.push(() => window.removeEventListener('keydown', handler, { capture: true }));
	};

	test('backtick, tilde, and Escape typed into a terminal reach the program', async () => {
		install_shortcuts();
		const terminal = create_running();
		const view = mount_view(terminal);
		await settle(view);
		const root = terminal_root(view);
		root.focus();
		app.ui.toggle_desk_menu(true);
		app.ui.toggle_desk_pinned(false);
		const sidebar = app.ui.show_sidebar;
		for (const init of [
			{ key: '`', code: 'Backquote' },
			{ key: '~', code: 'Backquote', shiftKey: true },
			{ key: 'Escape', code: 'Escape' }
		]) {
			assert.ok(key(root, init).defaultPrevented, `${init.key} taken by the terminal`);
		}
		assert.strictEqual(await sent_input(), '`~\x1b');
		assert.strictEqual(app.ui.show_sidebar, sidebar, 'the sidebar stayed');
		assert.isTrue(app.ui.show_desk_menu, 'the desk menu stayed open');
	});

	test('the shortcuts still work with focus elsewhere, and on a terminal that takes no keys', async () => {
		install_shortcuts();
		const terminal = create_running();
		const view = mount_view(terminal);
		await settle(view);
		const button = document.createElement('button');
		document.body.append(button);
		cleanups.push(() => button.remove());
		for (const target of [button, terminal_root(view)]) {
			if (target !== button) {
				terminal.receive_exited(0);
				flushSync();
			}
			target.focus();
			const sidebar = app.ui.show_sidebar;
			assert.ok(key(target, { key: '`', code: 'Backquote' }).defaultPrevented);
			assert.strictEqual(app.ui.show_sidebar, !sidebar, 'backtick toggles the sidebar');
			app.ui.toggle_desk_menu(false);
			key(target, { key: '~', code: 'Backquote', shiftKey: true });
			assert.isTrue(app.ui.show_desk_menu, 'tilde opens the desk menu');
			key(target, { key: 'Escape', code: 'Escape' });
			assert.isFalse(app.ui.show_desk_menu, 'Escape closes it');
		}
		assert.strictEqual(await sent_input(), '');
	});
});
