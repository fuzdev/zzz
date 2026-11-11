import type { FuzTerminalDeps } from '#lib/fuz_terminal/fuz_terminal_deps.ts';
import type { FuzTerminalFrameScheduler } from '#lib/fuz_terminal/fuz_terminal_frame.ts';
import type { FuzTerminalMeasurement } from '#lib/fuz_terminal/fuz_terminal_layout.ts';
import type { GhosttyVt } from '#lib/fuz_terminal/ghostty_vt.ts';

/** A frame scheduler stepped by hand: nothing runs until `step`. */
export interface ManualFrameScheduler extends FuzTerminalFrameScheduler {
	/** The callbacks scheduled and not yet run or cancelled. */
	readonly pending: number;
	/** How many frames have been requested in all. */
	readonly requested: number;
	/** Run the frames pending now (not ones they request); returns how many ran. */
	step: () => number;
}

export const create_manual_frame_scheduler = (): ManualFrameScheduler => {
	let next_id = 1;
	let requested = 0;
	const callbacks: Map<number, () => void> = new Map();
	return {
		get pending() {
			return callbacks.size;
		},
		get requested() {
			return requested;
		},
		request_frame: (callback) => {
			requested++;
			const id = next_id++;
			callbacks.set(id, callback);
			return id;
		},
		cancel_frame: (id) => {
			callbacks.delete(id);
		},
		step: () => {
			const due = [...callbacks];
			callbacks.clear();
			for (const [, callback] of due) callback();
			return due.length;
		}
	};
};

/** Timers on a clock advanced by hand. */
export interface ManualTimers {
	set_timeout: FuzTerminalDeps['set_timeout'];
	clear_timeout: FuzTerminalDeps['clear_timeout'];
	/** The timers not yet run or cleared. */
	readonly pending: number;
	/** Move the clock on `ms`, running each timer that comes due, in order. */
	advance: (ms: number) => void;
}

export const create_manual_timers = (): ManualTimers => {
	let now = 0;
	let next_id = 1;
	const timers: Map<number, { at: number; callback: () => void }> = new Map();
	return {
		set_timeout: (callback, ms) => {
			const id = next_id++;
			timers.set(id, { at: now + ms, callback });
			return id;
		},
		clear_timeout: (id) => {
			timers.delete(id);
		},
		get pending() {
			return timers.size;
		},
		advance: (ms) => {
			const until = now + ms;
			for (;;) {
				let due: [number, { at: number; callback: () => void }] | null = null;
				for (const entry of timers) {
					if (entry[1].at <= until && (due === null || entry[1].at < due[1].at)) due = entry;
				}
				if (due === null) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].callback();
			}
			now = until;
		}
	};
};

/**
 * Test deps for a terminal view: frames and timers stepped by hand, a
 * measurement the test sets (`null` for none), resize notifications the test
 * fires, and `load_vt` the test supplies.
 */
export interface TestFuzTerminalDeps extends FuzTerminalDeps {
	frames: ManualFrameScheduler;
	timers: ManualTimers;
	/** What `measure` returns. */
	measurement: FuzTerminalMeasurement | null;
	/** Fire the resize observers, as a box or font change would. */
	fire_resize: () => void;
	/** How many observations are live. */
	readonly observing: number;
}

export const create_test_fuz_terminal_deps = (
	load_vt: (module: WebAssembly.Module) => Promise<GhosttyVt>,
	measurement: FuzTerminalMeasurement | null = null
): TestFuzTerminalDeps => {
	const frames = create_manual_frame_scheduler();
	const timers = create_manual_timers();
	const observers: Set<() => void> = new Set();
	const deps: TestFuzTerminalDeps = {
		frames,
		timers,
		measurement,
		load_vt,
		request_frame: frames.request_frame,
		cancel_frame: frames.cancel_frame,
		set_timeout: timers.set_timeout,
		clear_timeout: timers.clear_timeout,
		observe_resize: (_elements, callback) => {
			observers.add(callback);
			return () => observers.delete(callback);
		},
		measure: () => deps.measurement,
		fire_resize: () => {
			for (const callback of [...observers]) callback();
		},
		get observing() {
			return observers.size;
		}
	};
	return deps;
};

/** A measurement of a box fitting `cols` × `rows` cells of 8 × 16 pixels, with some to spare. */
export const measurement_for = (cols: number, rows: number): FuzTerminalMeasurement => ({
	width: cols * 8 + 5,
	height: rows * 16 + 7,
	cell_width: 8,
	cell_height: 16
});
