/**
 * The frame loop a terminal view draws through: at most one frame pending,
 * requested when something may have changed and idle otherwise — never a
 * perpetual `requestAnimationFrame`.
 *
 * @module
 */

/**
 * Schedules a callback for the next frame, as `requestAnimationFrame` does —
 * the default — and cancels one. Tests pass a scheduler they step by hand.
 */
export interface FuzTerminalFrameScheduler {
	/** Schedule `callback` for the next frame, returning an id `cancel_frame` takes. */
	request_frame: (callback: () => void) => number;
	cancel_frame: (id: number) => void;
}

/**
 * Coalesces frame requests: any number of `request` calls before a frame
 * runs schedule it once, and a request made while the frame runs schedules
 * the next one. After `stop` nothing is scheduled again.
 *
 * The frame callback runs guarded: an exception out of it is handed to
 * `on_error` rather than escaping into the scheduler (an exception out of an
 * animation-frame callback is reported as unhandled).
 */
export class FuzTerminalFrameLoop {
	readonly #scheduler: FuzTerminalFrameScheduler;
	readonly #on_frame: () => void;
	readonly #on_error: (error: unknown) => void;
	/** The pending frame's id, or `null` when none is pending. */
	#pending: number | null = null;
	#stopped = false;

	/**
	 * @param scheduler - schedules and cancels frames
	 * @param on_frame - draws a frame
	 * @param on_error - receives an exception `on_frame` threw
	 */
	constructor(
		scheduler: FuzTerminalFrameScheduler,
		on_frame: () => void,
		on_error: (error: unknown) => void
	) {
		this.#scheduler = scheduler;
		this.#on_frame = on_frame;
		this.#on_error = on_error;
	}

	/** Schedule a frame, unless one is pending or the loop is stopped. */
	request(): void {
		if (this.#pending !== null || this.#stopped) return;
		this.#pending = this.#scheduler.request_frame(this.#run);
	}

	/** Cancel the pending frame, if any, and never schedule another. Idempotent. */
	stop(): void {
		this.#stopped = true;
		const pending = this.#pending;
		if (pending === null) return;
		this.#pending = null;
		this.#scheduler.cancel_frame(pending);
	}

	readonly #run = (): void => {
		// cleared first, so the frame can request the next one
		this.#pending = null;
		if (this.#stopped) return;
		try {
			this.#on_frame();
		} catch (error) {
			this.#on_error(error);
		}
	};
}
