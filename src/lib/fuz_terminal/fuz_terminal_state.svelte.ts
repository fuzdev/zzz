/**
 * The state behind `FuzTerminal`: one view's emulator — its own module
 * instance, terminal, and render-state reader — and the frame loop that
 * reads it into the plain frame data the component draws.
 *
 * @module
 */

import { GhosttyEffectError } from './ghostty_errors.ts';
import { GhosttyKeyEncoder, type GhosttyKeyAction } from './ghostty_key_encoder.ts';
import {
	GhosttyRenderState,
	type GhosttyRenderColors,
	type GhosttyRenderCursor,
	type GhosttyRenderRow,
	type GhosttyRenderStyle
} from './ghostty_render_state.ts';
import { GhosttyTerminal } from './ghostty_terminal.ts';
import type { GhosttyVt } from './ghostty_vt.ts';
import type { FuzTerminalDeps } from './fuz_terminal_deps.ts';
import { FuzTerminalFrameLoop } from './fuz_terminal_frame.ts';
import {
	is_fuz_terminal_key_composing,
	resolve_fuz_terminal_key_codes,
	should_fuz_terminal_pass_key,
	to_fuz_terminal_key_input,
	type FuzTerminalKeyCodes,
	type FuzTerminalKeyboardEvent
} from './fuz_terminal_keyboard.ts';
import {
	fuz_terminal_size_equals,
	to_fuz_terminal_cursor_box,
	to_fuz_terminal_size,
	type FuzTerminalCursorBox,
	type FuzTerminalMeasurement,
	type FuzTerminalSize
} from './fuz_terminal_layout.ts';
import {
	FuzTerminalStyleCache,
	format_fuz_terminal_rgb,
	to_fuz_terminal_theme_css
} from './fuz_terminal_style.ts';

/**
 * How long a render hold (synchronized output, mode 2026) is honored, in
 * milliseconds. The library has no clock and never ends a hold itself, so a
 * program that sets the mode and never resets it would otherwise freeze the
 * view; past this, the view draws again.
 */
export const FUZ_TERMINAL_RENDER_HOLD_TIMEOUT_MS = 1000;

/** The size a terminal is created at when its view can't be measured yet. */
export const FUZ_TERMINAL_DEFAULT_SIZE: FuzTerminalSize = { cols: 80, rows: 24 };

/**
 * The most writes the host's callbacks may make while one write (or resize)
 * runs — an `ondata` that writes each reply back as output, say, which would
 * otherwise loop forever. Past it, further writes from callbacks are dropped
 * and reported through `onerror`; the view goes on.
 */
export const FUZ_TERMINAL_MAX_CALLBACK_WRITES = 256;

/**
 * Where a terminal view is:
 *
 * - `loading` - waiting for its module, instantiating it, creating its terminal
 * - `ready` - drawing
 * - `failed` - the module didn't arrive, compile, or instantiate, the
 *   terminal couldn't be created, or the library failed; nothing more is
 *   drawn or written
 * - `poisoned` - an exception escaped a call into the module instance
 *   (`GhosttyVt.poisoned`); nothing more is drawn or written, and the host
 *   recovers by mounting a new view
 */
export type FuzTerminalStatus =
	| { readonly kind: 'loading' }
	| { readonly kind: 'ready' }
	| { readonly kind: 'failed'; readonly error: unknown; readonly message: string }
	| { readonly kind: 'poisoned'; readonly error: unknown; readonly message: string };

/** How `FuzTerminalState.write` treats one write. */
export interface FuzTerminalWriteOptions {
	/**
	 * Output written earlier, replayed (a buffered history): it's processed
	 * with no reply effects registered, so a query in it gets no reply and a
	 * bell in it rings nothing — whenever it arrives and whatever it's
	 * interleaved with. A title it sets still reaches `ontitle`, and a render
	 * hold it starts is honored. What it does to the terminal's state carries
	 * forward, as when live output continues it: a query it ends partway
	 * through is answered once live output completes it.
	 */
	replay?: boolean;
}

/**
 * A terminal view's host: what it's given once, and the callbacks it calls.
 * `FuzTerminal` passes its props, which are read lazily — `module` and
 * `scrollback_max_bytes` once, when the view starts; each callback whenever
 * it's called, so a callback prop can change.
 *
 * The callbacks for the terminal's effects (`ondata`, `ontitle`, `onbell`)
 * run synchronously inside the write that fired them; none is called once
 * the view is destroyed. An exception from any callback is caught: it never
 * escapes a frame or a write, and is reported through `onerror` (or the
 * console) and the view's notice.
 */
export interface FuzTerminalOptions {
	/**
	 * The compiled libghostty-vt module, or a promise of it (a fetch and
	 * compile in flight: the view is `loading` until it settles, and `failed`
	 * if it rejects). The view instantiates its own instance of it.
	 */
	module: WebAssembly.Module | Promise<WebAssembly.Module>;
	/** The most scrollback to keep, in bytes; defaults to the library's small limit. */
	scrollback_max_bytes?: number;
	/**
	 * Bytes for the PTY, in order: the keys typed into the focused view, and
	 * the terminal's replies to the program's queries.
	 */
	ondata?: (data: Uint8Array) => void;
	/** The terminal's size in cells changed: at creation, and when the view's box or font changes. */
	onresize?: (size: FuzTerminalSize) => void;
	/** The program set the title; render it as text. */
	ontitle?: (title: string) => void;
	/** The program rang the bell. */
	onbell?: () => void;
	/** The view's status changed. */
	onstatus?: (status: FuzTerminalStatus) => void;
	/** A callback threw, or wrote too much; the view goes on. Without this, it's logged to the console. */
	onerror?: (error: unknown) => void;
}

/** A write waiting its turn: while loading, or made from a callback inside a write. */
interface QueuedWrite {
	data: Uint8Array | string;
	replay: boolean;
}

/**
 * One terminal view's emulator and frame data. Not a Cell: it holds a wasm
 * instance and DOM elements, and serializes nothing.
 *
 * Owned by `FuzTerminal`, which calls `attach` once mounted (loading starts
 * there, never on the server) and `destroy` on unmount, which frees the
 * terminal and its reader and drops the instance, so its memory can be
 * collected.
 *
 * Each frame — at most one per animation frame, and only after output, a
 * resize, or a render hold ending — updates the reader and takes what
 * changed: `rows` when the update wasn't clean, and `cursor` and the colors
 * by reference every frame, since they change on clean updates too.
 */
// TODO: paste and IME on the focused root; focus reporting; mouse reporting
// TODO: scrollback — scrolling the viewport (`ghostty_terminal_scroll_viewport`) and a scrollbar
// TODO: set the theme's colors on the terminal, so color queries (OSC 10/11/4)
// answer with what's drawn rather than the library's placeholders, and
// reverse video (DECSCNM) swaps them
export class FuzTerminalState {
	/** Where the view is; see `FuzTerminalStatus`. */
	status: FuzTerminalStatus = $state.raw({ kind: 'loading' });
	/**
	 * The frame's rows, the reader's own array: replaced on each update that
	 * wasn't clean, with an unchanged row the same object as before.
	 */
	rows: ReadonlyArray<GhosttyRenderRow> = $state.raw([]);
	/** The frame's cursor, the reader's own object; `null` before the first frame. */
	cursor: GhosttyRenderCursor | null = $state.raw(null);
	/** The root's inline custom properties for the frame's colors (`to_fuz_terminal_theme_css`). */
	theme_css: string = $state('');
	/** The cursor color a program set (OSC 12), as CSS; `null` for the theme's. */
	cursor_color: string | null = $state(null);
	/** The measured cell, in CSS pixels; `null` until the view is measured. */
	cell_width: number | null = $state(null);
	cell_height: number | null = $state(null);
	/** The terminal's size in cells; `null` until it's created. */
	size: FuzTerminalSize | null = $state.raw(null);
	/** Whether focus is in the view: the cursor is hollow and still without it. */
	focused: boolean = $state(false);
	/** The last callback error, shown as a plain-text notice; `null` when there's none. */
	notice: string | null = $state(null);

	/** Where to draw the cursor, or `null` for nowhere. */
	readonly cursor_box: FuzTerminalCursorBox | null = $derived.by(() =>
		this.cursor === null || this.status.kind === 'loading'
			? null
			: to_fuz_terminal_cursor_box(this.cursor, this.rows, this.focused)
	);

	/** The host's options, read lazily: a getter, so they're the props in effect when read. */
	readonly #options: () => FuzTerminalOptions;
	readonly #deps: FuzTerminalDeps;
	readonly #frame: FuzTerminalFrameLoop;
	readonly #styles: FuzTerminalStyleCache = new FuzTerminalStyleCache();

	#vt: GhosttyVt | null = null;
	#terminal: GhosttyTerminal | null = null;
	#render_state: GhosttyRenderState | null = null;
	#key_encoder: GhosttyKeyEncoder | null = null;
	#key_codes: FuzTerminalKeyCodes | null = null;
	/**
	 * The `code`s of the keys whose press went to the encoder and that haven't
	 * come up: a release is encoded only for one of these, so a program never
	 * hears a key come up that it didn't hear go down.
	 */
	readonly #held_keys: Set<string> = new Set();
	/** The colors before any output: the library's palette and placeholder defaults. */
	#baseline: GhosttyRenderColors | null = null;
	/** The colors `theme_css` was made from. */
	#colors: GhosttyRenderColors | null = null;

	#root: HTMLElement | null = null;
	#probe: HTMLElement | null = null;
	#unobserve: (() => void) | null = null;
	#attached = false;
	#destroyed = false;
	/** Whether a call into the terminal that fires effects (a write, a resize) is running. */
	#busy = false;
	/** Writes waiting their turn, in order. */
	readonly #queue: Array<QueuedWrite> = [];
	/** Writes the callbacks have made since the outermost write or resize began. */
	#callback_writes = 0;
	/** Whether a callback write was dropped since then (reported once). */
	#callback_writes_dropped = false;
	/** Whether a render hold is honored now: no update until it ends or times out. */
	#held = false;
	#hold_timer: number | null = null;
	/** Whether the box may have changed size since the terminal was last sized. */
	#size_stale = false;
	/** Whether the first frame should check that the box has a size (it had none at start). */
	#size_check_pending = false;

	/**
	 * @param options - the host's options, read lazily (see `FuzTerminalOptions`)
	 * @param deps - frames, timers, measuring, and loading
	 */
	constructor(options: () => FuzTerminalOptions, deps: FuzTerminalDeps) {
		this.#options = options;
		this.#deps = deps;
		this.#frame = new FuzTerminalFrameLoop(deps, this.#on_frame, (error) =>
			this.#handle_error(error)
		);
	}

	/**
	 * A style's CSS, cached by key (`to_fuz_terminal_style_css`). A stable
	 * function, so passing it to a row doesn't re-render the row.
	 */
	readonly style_css = (style: GhosttyRenderStyle): string => this.#styles.get(style);

	/**
	 * Start: observe `root` and `probe` for size changes, then load the module
	 * and create the terminal, sized to `root`. Once only.
	 *
	 * @param root - the element the rows fill, measured for the size
	 * @param probe - a run of cells in the terminal's font, measured for the cell
	 */
	attach(root: HTMLElement, probe: HTMLElement): void {
		if (this.#attached || this.#destroyed) return;
		this.#attached = true;
		this.#root = root;
		this.#probe = probe;
		this.#unobserve = this.#deps.observe_resize([root, probe], this.#on_resize);
		void this.#start();
	}

	/**
	 * Feed program output, written in the order of the calls: while loading
	 * it's queued; from a callback inside a write it's written right after
	 * that write (at most `FUZ_TERMINAL_MAX_CALLBACK_WRITES` of them). Ignored
	 * once the view has failed, been poisoned, or been destroyed.
	 */
	write(data: Uint8Array | string, options?: FuzTerminalWriteOptions): void {
		if (data.length === 0 || !this.#accepting) return;
		const replay = options?.replay === true;
		if (this.#busy) {
			if (this.#callback_writes >= FUZ_TERMINAL_MAX_CALLBACK_WRITES) {
				if (!this.#callback_writes_dropped) {
					this.#callback_writes_dropped = true;
					this.#report(
						new Error(
							`dropped output written from a callback: more than ${FUZ_TERMINAL_MAX_CALLBACK_WRITES} writes during one write (does ondata write its replies back as output?)`
						)
					);
				}
				return;
			}
			this.#callback_writes++;
			this.#queue.push({ data, replay });
			return;
		}
		if (this.status.kind === 'loading') {
			this.#queue.push({ data, replay });
			return;
		}
		this.#begin_outermost();
		this.#write_now(data, replay);
		this.#drain();
		this.#frame.request();
	}

	/**
	 * The screen as plain text, scrollback included, soft wraps joined and
	 * trailing spaces trimmed (`GhosttyTerminal.format_text`); `''` when
	 * there's no usable terminal.
	 */
	get_text(): string {
		const terminal = this.#terminal;
		if (terminal === null || !this.#usable) return '';
		try {
			return terminal.format_text();
		} catch (error) {
			this.#handle_error(error);
			return '';
		}
	}

	/**
	 * A key event on the focused view: a `keydown`'s press or repeat, or a
	 * `keyup`'s release, encoded under the terminal's modes as they are now,
	 * and its bytes, if any, sent to `ondata`.
	 *
	 * Not taken — nothing encoded or sent — while the view isn't ready, for a
	 * keydown in a composition (an IME's, or a dead key's: the composed
	 * character arrives as a later keydown) or one the browser and the OS keep
	 * (`should_fuz_terminal_pass_key`), and for a keyup whose keydown wasn't
	 * taken. A taken keydown's keyup is always encoded, whatever its
	 * modifiers are by then. A release sends bytes only under the Kitty
	 * keyboard protocol with event reporting on; the encoder decides. The
	 * keys follow `FuzTerminalDeps.key_platform`'s conventions.
	 *
	 * @returns whether bytes were sent: the caller prevents the event's
	 *   default exactly then, so a modifier alone, or a key the encoder has
	 *   nothing for, keeps its default
	 */
	handle_key(event: FuzTerminalKeyboardEvent, type: 'keydown' | 'keyup'): boolean {
		const encoder = this.#key_encoder;
		const codes = this.#key_codes;
		// keys arrive outside writes; one dispatched from inside a callback is refused
		if (encoder === null || codes === null || !this.#usable || this.#busy) return false;
		let action: GhosttyKeyAction;
		if (type === 'keyup') {
			// a taken press's release is always encoded, whatever the modifiers
			// are by now (Meta added, Ctrl+Shift+C formed) — and only one
			if (!this.#held_keys.delete(event.code)) return false;
			action = 'release';
		} else {
			if (is_fuz_terminal_key_composing(event)) return false;
			if (should_fuz_terminal_pass_key(event)) return false;
			this.#held_keys.add(event.code);
			action = event.repeat ? 'repeat' : 'press';
		}
		let bytes: Uint8Array;
		try {
			bytes = encoder.encode(
				to_fuz_terminal_key_input(event, action, codes, this.#deps.key_platform)
			);
		} catch (error) {
			this.#handle_error(error);
			return false;
		}
		if (bytes.length === 0) return false;
		// TODO: scroll the viewport to the bottom on input, once it scrolls
		this.#call_host(() => this.#options().ondata?.(bytes));
		return true;
	}

	/**
	 * Forget the keys held down, when focus leaves the view: their releases
	 * go elsewhere, so none is sent for them later.
	 */
	forget_held_keys(): void {
		this.#held_keys.clear();
	}

	/**
	 * Stop: cancel the frame and the hold timer, stop observing, free the
	 * terminal and its reader, and drop the instance. Idempotent; from a
	 * callback inside a write, the freeing waits for the write to return.
	 */
	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#frame.stop();
		this.#clear_hold_timer();
		this.#held = false;
		this.#unobserve?.();
		this.#unobserve = null;
		this.#root = null;
		this.#probe = null;
		this.#queue.length = 0;
		if (!this.#busy) this.#dispose();
	}

	/** Whether output is still taken: not failed, poisoned, or destroyed. */
	get #accepting(): boolean {
		const { kind } = this.status;
		return !this.#destroyed && (kind === 'loading' || kind === 'ready');
	}

	/** Whether the terminal may be called: created, ready, and not destroyed. */
	get #usable(): boolean {
		return !this.#destroyed && this.status.kind === 'ready' && this.#terminal !== null;
	}

	async #start(): Promise<void> {
		const options = this.#options();
		let vt: GhosttyVt;
		try {
			const module = await options.module;
			// unmounted while the module was on its way: nothing is instantiated
			if (this.#destroyed) return;
			vt = await this.#deps.load_vt(module);
		} catch (error) {
			if (!this.#destroyed) this.#stop({ kind: 'failed', error, message: to_message(error) });
			return;
		}
		// unmounted while loading: the instance is dropped, nothing made in it
		if (this.#destroyed) return;
		this.#vt = vt;
		const measured = this.#measure();
		const size = measured?.size ?? FUZ_TERMINAL_DEFAULT_SIZE;
		try {
			const terminal = new GhosttyTerminal(vt, {
				cols: size.cols,
				rows: size.rows,
				scrollback_max_bytes: options.scrollback_max_bytes
			});
			this.#terminal = terminal;
			if (measured) {
				// the same size, now with the cell's pixel size for the terminal's size reports
				terminal.resize({ cols: size.cols, rows: size.rows, ...cell_pixels(measured.measurement) });
			}
			const render_state = new GhosttyRenderState(terminal);
			this.#render_state = render_state;
			this.#key_codes = vt.resolve(resolve_fuz_terminal_key_codes);
			this.#key_encoder = new GhosttyKeyEncoder(terminal);
			// read before any output can change them: the library's own palette
			// and placeholder defaults, which `theme_css` compares against
			render_state.update();
			this.#baseline = render_state.colors;
			this.#take_frame(render_state, true);
			render_state.clean();
			terminal.set_effect('render_hold', this.#on_render_hold);
			terminal.set_effect('title_changed', this.#on_title);
			this.#set_reply_effects(terminal, true);
		} catch (error) {
			this.#handle_error(error);
			return;
		}
		this.size = size;
		if (measured) this.#take_cell(measured.measurement);
		else this.#size_check_pending = true;
		// ready before the queue drains, so writes made while loading come first;
		// the host hears of it after, so a write it makes then follows them
		this.status = { kind: 'ready' };
		this.#begin_outermost();
		this.#drain();
		if (this.#destroyed || this.status.kind !== 'ready') return;
		const ready = this.status;
		this.#call_host(() => this.#options().onstatus?.(ready));
		if (this.#destroyed || this.status.kind !== 'ready') return;
		this.#call_host(() => this.#options().onresize?.(size));
		if (this.#destroyed || this.status.kind !== 'ready') return;
		this.#frame.request();
	}

	/** A new outermost write or resize: the callbacks' write budget starts over. */
	#begin_outermost(): void {
		this.#callback_writes = 0;
		this.#callback_writes_dropped = false;
	}

	/**
	 * Register the reply effects (`write_pty`, `bell`), or clear them for a
	 * replayed write. Never from inside one of the terminal's calls: callers
	 * run outside `#busy`.
	 */
	#set_reply_effects(terminal: GhosttyTerminal, on: boolean): void {
		terminal.set_effect('write_pty', on ? this.#on_write_pty : null);
		terminal.set_effect('bell', on ? this.#on_bell : null);
	}

	readonly #on_write_pty = (data: Uint8Array): void => {
		if (!this.#destroyed) this.#options().ondata?.(data);
	};

	readonly #on_bell = (): void => {
		if (!this.#destroyed) this.#options().onbell?.();
	};

	readonly #on_title = (title: string): void => {
		if (!this.#destroyed) this.#options().ontitle?.(title);
	};

	/** Write to the terminal, marked busy, routing any error; a replay with the reply effects cleared. */
	#write_now(data: Uint8Array | string, replay: boolean): void {
		const terminal = this.#terminal;
		if (terminal === null) return;
		if (replay) {
			try {
				this.#set_reply_effects(terminal, false);
			} catch (error) {
				this.#handle_error(error);
				return;
			}
		}
		this.#busy = true;
		try {
			terminal.write(data);
		} catch (error) {
			this.#handle_error(error);
		} finally {
			this.#busy = false;
		}
		if (this.#destroyed) {
			this.#dispose();
			return;
		}
		if (replay && this.#usable) {
			try {
				this.#set_reply_effects(terminal, true);
			} catch (error) {
				this.#handle_error(error);
			}
		}
	}

	/** Write what was queued, in order, while the terminal takes it. */
	#drain(): void {
		while (this.#queue.length > 0 && this.#usable) {
			const next = this.#queue.shift()!;
			this.#write_now(next.data, next.replay);
		}
	}

	readonly #on_frame = (): void => {
		if (!this.#usable) return;
		if (this.#size_check_pending) {
			this.#size_check_pending = false;
			this.#warn_if_unsized();
		}
		if (this.#size_stale) {
			this.#size_stale = false;
			this.#fit();
			if (!this.#usable) return;
		}
		if (this.#held) return;
		this.#update();
	};

	/** Update the reader and take the frame, routing any error. */
	#update(): void {
		const render_state = this.#render_state;
		if (render_state === null) return;
		try {
			const dirty = render_state.update();
			this.#take_frame(render_state, dirty !== 'clean');
			render_state.clean();
		} catch (error) {
			this.#handle_error(error);
		}
	}

	/** Take what changed: the rows when the update read them, the cursor and colors by reference. */
	#take_frame(render_state: GhosttyRenderState, rows_changed: boolean): void {
		// TODO: a scroll inside a scroll region (and inserted or deleted lines)
		// gives every row of the library's page a new id, so those frames
		// recreate every row's elements; measure a full-screen program before
		// matching rows by content
		if (rows_changed) this.rows = render_state.rows;
		if (render_state.cursor !== this.cursor) this.cursor = render_state.cursor;
		const colors = render_state.colors;
		if (colors !== this.#colors && this.#baseline !== null) {
			this.#colors = colors;
			this.theme_css = to_fuz_terminal_theme_css(colors, this.#baseline);
			// its own property, so a cursor color change (vim's, per mode) leaves the palette alone
			this.cursor_color = colors.cursor === null ? null : format_fuz_terminal_rgb(colors.cursor);
		}
	}

	/** Take the measured cell, which the runs and the cursor are sized by. */
	#take_cell(measurement: FuzTerminalMeasurement): void {
		this.cell_width = measurement.cell_width;
		this.cell_height = measurement.cell_height;
	}

	readonly #on_resize = (): void => {
		this.#size_stale = true;
		this.#frame.request();
	};

	/** The box's measurement and the size it fits, or `null` when it can't be measured. */
	#measure(): { measurement: FuzTerminalMeasurement; size: FuzTerminalSize } | null {
		const root = this.#root;
		const probe = this.#probe;
		if (root === null || probe === null) return null;
		const measurement = this.#deps.measure(root, probe);
		if (measurement === null) return null;
		const size = to_fuz_terminal_size(measurement);
		return size === null ? null : { measurement, size };
	}

	/**
	 * Warn, once per view, when it's ready and its first frame still finds a
	 * box with no size: the rows are a layer over the box, so an unsized
	 * container draws nothing, which would otherwise look like a hang. Only a
	 * warning — never the status. A view that's legitimately hidden
	 * (`display: none`) when it starts trips it too; that's accepted.
	 */
	#warn_if_unsized(): void {
		if (this.#measure() !== null) return;
		console.warn(
			'[FuzTerminal] the view is ready but its box has no size, so nothing is drawn: give it a container with a definite size (an explicit height, or a stretched flex or grid item with `min-height: 0` in a flex column)'
		);
	}

	/** Resize the terminal to fit the box, if it's measurable and the size changed. */
	#fit(): void {
		const terminal = this.#terminal;
		const measured = this.#measure();
		if (terminal === null || measured === null) return;
		const { size, measurement } = measured;
		this.#take_cell(measurement);
		if (fuz_terminal_size_equals(size, this.size)) return;
		this.#begin_outermost();
		this.#busy = true;
		let fatal = false;
		try {
			terminal.resize({ cols: size.cols, rows: size.rows, ...cell_pixels(measurement) });
		} catch (error) {
			// a callback's error leaves the resize done
			fatal = this.#handle_error(error);
		} finally {
			this.#busy = false;
		}
		if (this.#destroyed) {
			this.#dispose();
			return;
		}
		if (fatal) return;
		this.size = size;
		this.#drain();
		if (!this.#usable) return;
		this.#call_host(() => this.#options().onresize?.(size));
	}

	/**
	 * The `render_hold` effect, inside a write or resize. At a hold's start the
	 * terminal holds exactly the frame the program wants left on screen, so
	 * it's taken here; then nothing updates until the hold ends or times out.
	 * Nothing happens once the view is destroyed or stopped — the same write
	 * can go on parsing after a callback unmounted the view, or after the
	 * hold's own update poisoned the instance.
	 */
	readonly #on_render_hold = (held: boolean): void => {
		if (!this.#accepting) return;
		this.#clear_hold_timer();
		if (held) {
			this.#update();
			if (!this.#accepting) return;
			this.#held = true;
			this.#hold_timer = this.#deps.set_timeout(
				this.#on_hold_timeout,
				FUZ_TERMINAL_RENDER_HOLD_TIMEOUT_MS
			);
		} else {
			this.#held = false;
			this.#frame.request();
		}
	};

	readonly #on_hold_timeout = (): void => {
		this.#hold_timer = null;
		if (!this.#held) return;
		// TODO: end the hold in the terminal too, by resetting mode 2026
		// (`GHOSTTY_TERMINAL_OPT_MODE`, unbound) — until then the view just
		// draws again, and a hold the program starts before resetting this one
		// isn't seen
		this.#held = false;
		this.#frame.request();
	};

	#clear_hold_timer(): void {
		if (this.#hold_timer === null) return;
		this.#deps.clear_timeout(this.#hold_timer);
		this.#hold_timer = null;
	}

	/**
	 * Route an error: a poisoned instance or any failure of the library stops
	 * the view; a callback's exception (`GhosttyEffectError`) is reported and
	 * the view goes on.
	 *
	 * @returns whether the view stopped
	 */
	#handle_error(error: unknown): boolean {
		const poison = this.#vt?.poisoned;
		if (poison) {
			this.#stop({ kind: 'poisoned', error: poison.cause, message: to_message(poison.cause) });
			return true;
		}
		if (error instanceof GhosttyEffectError) {
			this.#report(error.cause);
			return false;
		}
		this.#stop({ kind: 'failed', error, message: to_message(error) });
		return true;
	}

	/** Stop drawing and writing, keeping the last frame on screen. The first stop wins. */
	#stop(status: FuzTerminalStatus): void {
		const { kind } = this.status;
		if (kind === 'failed' || kind === 'poisoned') return;
		this.#frame.stop();
		this.#clear_hold_timer();
		this.#held = false;
		this.#queue.length = 0;
		this.status = status;
		if (!this.#destroyed) this.#call_host(() => this.#options().onstatus?.(status));
	}

	/** Call a host callback outside a write, so an exception it throws is reported, not thrown. */
	#call_host(call: () => void): void {
		try {
			call();
		} catch (error) {
			this.#report(error);
		}
	}

	/** Show an error and hand it to `onerror`, or the console. */
	#report(error: unknown): void {
		this.notice = to_message(error);
		const { onerror } = this.#options();
		try {
			if (onerror) onerror(error);
			else console.error('[FuzTerminal] a callback failed:', error);
		} catch (onerror_error) {
			console.error('[FuzTerminal] onerror threw:', onerror_error, 'reporting:', error);
		}
	}

	/** Free the terminal (which frees its reader and key encoder first) and drop the instance. */
	#dispose(): void {
		const terminal = this.#terminal;
		this.#terminal = null;
		this.#render_state = null;
		this.#key_encoder = null;
		this.#key_codes = null;
		this.#held_keys.clear();
		this.#vt = null;
		if (terminal === null) return;
		try {
			terminal.dispose();
		} catch (error) {
			// never expected: `dispose` throws only from inside one of the
			// terminal's own calls, which `#busy` defers past
			console.error('[FuzTerminal] disposing the terminal threw:', error);
		}
	}
}

/** A measurement's cell in whole pixels, for the terminal's size reports. */
const cell_pixels = (
	measurement: FuzTerminalMeasurement
): { cell_width_px: number; cell_height_px: number } => ({
	cell_width_px: Math.round(measurement.cell_width),
	cell_height_px: Math.round(measurement.cell_height)
});

const to_message = (error: unknown): string => {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return 'an error with no message';
	}
};
