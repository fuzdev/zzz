import { z } from 'zod';
import { SvelteDate } from 'svelte/reactivity';
import { BROWSER } from 'esm-env';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';
import {
	format_datetime,
	format_short_date,
	format_time,
	format_timestamp
} from './time_helpers.ts';

// ticks land this far past each boundary, so a timer firing a hair early
// (clock adjustments, timer coalescing) still reads the new minute
const TICK_SLACK_MS = 10;

/**
 * The longest `Time` interval, in milliseconds (about 24.8 days): the largest
 * delay `setTimeout` takes — a longer one overflows and fires at once.
 */
export const TIME_INTERVAL_MAX = 2_147_483_647;

export const TimeJson = CellJson.extend({}).meta({ cell_class_name: 'Time' });
export type TimeJson = z.infer<typeof TimeJson>;
export type TimeJsonInput = z.input<typeof TimeJson>;

/**
 * Options for configuring a Time instance.
 */
export interface TimeOptions extends CellOptions<typeof TimeJson> {
	/**
	 * Interval in milliseconds for updating now — positive, at most
	 * `TIME_INTERVAL_MAX`.
	 * Ticks land on local wall-clock multiples of it (see `Time.start`).
	 * @default 60_000 (1 minute)
	 */
	interval?: number;

	/**
	 * Whether to automatically start the timer on initialization.
	 * @default true in browser, false otherwise
	 */
	autostart?: boolean;
}

/**
 * Reactive time management class that provides time-related utilities.
 * Has a configurable update interval that defaults to
 * a full minute to minimize wasteful reactivity,
 * so it's suitable for any cases that need at best 1-minute precision, unless reconfigured.
 */
export class Time extends Cell<typeof TimeJson> {
	/**
	 * Default update interval in milliseconds (1 minute).
	 * The idea is to minimize reactivity and CPU usage for a common use case.
	 */
	static DEFAULT_INTERVAL = 60_000;

	/**
	 * Current time that updates on the configured interval.
	 * This is reactive and can be used in derived computations.
	 */
	readonly now: SvelteDate = new SvelteDate();
	readonly now_ms: number = $derived(this.now.getTime());
	readonly now_timestamp = $derived(format_timestamp(this.now));
	readonly now_formatted_short_date: string = $derived(format_short_date(this.now));
	readonly now_formatted_datetime: string = $derived(format_datetime(this.now));
	readonly now_formatted_time: string = $derived(format_time(this.now));

	/**
	 * The interval in milliseconds between time updates. Change it with `restart`.
	 */
	get interval(): number {
		return this.#interval;
	}
	#interval: number = $state.raw(Time.DEFAULT_INTERVAL);

	/**
	 * Whether the interval timer is currently running.
	 */
	running: boolean = $state.raw(false);

	#timer?: ReturnType<typeof setTimeout>;

	constructor(options: TimeOptions) {
		// Pass schema and options to base constructor
		super(TimeJson, options);

		if (options.interval !== undefined) {
			validate_time_interval(options.interval);
			this.#interval = options.interval;
		}

		// Auto-start based on options or default to browser environment
		const autostart = options.autostart ?? BROWSER;
		if (autostart) {
			this.start();
		}

		// Initialize cell
		this.init();
	}

	/**
	 * Starts the interval timer if it's not already running. Ticks land on
	 * local wall-clock multiples of `interval` — the top of each minute by
	 * default, the top of each local hour for an hour interval (even in a
	 * half-hour timezone) — so a displayed `h:mm` changes when the clock does
	 * instead of up to a full interval late. The UTC offset is read at each
	 * tick, so a DST change realigns the next one. An interval that doesn't
	 * divide a day evenly has no natural boundary: it still ticks every
	 * `interval`, at an arbitrary phase.
	 */
	start(): boolean {
		if (this.running) return false;

		this.update_now();
		this.#schedule();

		this.running = true;
		return true;
	}

	// a `setTimeout` chain rather than `setInterval`, so each tick re-aligns
	// to the boundary after timer drift or background-tab throttling
	#schedule(): void {
		const now = Date.now();
		// local wall-clock ms — the offset is in minutes, positive west of UTC
		const local = now - new Date(now).getTimezoneOffset() * 60_000;
		const interval = this.#interval;
		const since_boundary = ((local % interval) + interval) % interval;
		this.#timer = setTimeout(
			() => {
				this.update_now();
				this.#schedule();
			},
			// a tick cut short by the cap lands just early, and the next one realigns
			Math.min(interval - since_boundary + TICK_SLACK_MS, TIME_INTERVAL_MAX)
		);
	}

	/**
	 * Stops the interval timer if it's running.
	 */
	stop(): boolean {
		if (!this.running) return false;

		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		this.running = false;
		return true;
	}

	/**
	 * Restarts the interval timer, optionally with a new interval.
	 *
	 * @throws Error when `interval` isn't a positive number of milliseconds
	 * up to `TIME_INTERVAL_MAX`
	 */
	restart(interval?: number): void {
		if (interval !== undefined) {
			validate_time_interval(interval);
			this.#interval = interval;
		}

		this.stop();
		this.start();
	}

	/**
	 * Updates the now to the current time immediately.
	 */
	update_now(value = Date.now()): void {
		this.now.setTime(value);
	}

	/**
	 * Override `Cell.dispose` to stop the interval timer before unregistering.
	 */
	override dispose(): void {
		this.stop();
		super.dispose();
	}
}

/**
 * Validates a `Time` interval.
 *
 * @throws Error when `interval` isn't a positive number of milliseconds up to
 * `TIME_INTERVAL_MAX` — zero, negative, `NaN`, or too long for `setTimeout`
 */
const validate_time_interval = (interval: number): void => {
	if (!(interval > 0 && interval <= TIME_INTERVAL_MAX)) {
		throw new Error(
			`Time interval must be a positive number of milliseconds up to ${TIME_INTERVAL_MAX}, got ${interval}`
		);
	}
};
