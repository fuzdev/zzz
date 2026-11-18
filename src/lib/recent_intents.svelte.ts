import { untrack } from 'svelte';

import type { IntentActionSpec } from './intent_spec.ts';

/** How many intents `RecentIntents` keeps. */
export const RECENT_INTENTS_LIMIT = 200;

/** An inverse intent call, the shape a later undo replays. */
export interface IntentCall {
	readonly method: string;
	readonly version: number;
	readonly input: unknown;
}

/** One intent call, as `RecentIntents` keeps it. */
export interface RecentIntent extends IntentCall {
	/** Increasing per page, so entries order and key without a clock. */
	readonly seq: number;
	readonly history: IntentActionSpec['history'];
	/** When it finished, in ms since the epoch. */
	readonly at: number;
	readonly outcome: 'applied' | 'failed';
	/** The failure's message, for a `failed` outcome. */
	readonly error: string | null;
	/**
	 * The call that undoes this one. Always `null` until layout undo is built
	 * (each layout intent then produces its inverse from the state it changed);
	 * the slot is here so entries don't change shape when it arrives.
	 */
	readonly inverse: IntentCall | null;
}

/**
 * The bounded buffer of recent intents — the API's only memory of what was
 * done. Shown on the actions page beside the wire log; later read by
 * reopen-closed-tab and layout undo. Never persisted beyond its bound.
 *
 * Kept apart from the `Actions` wire log: RPC traffic would evict intents
 * there, and a full `Action` cell per call costs more than an intent should.
 */
export class RecentIntents {
	readonly limit: number;

	/** Oldest first. */
	entries: ReadonlyArray<RecentIntent> = $state.raw([]);

	#seq = 0;

	constructor(limit: number = RECENT_INTENTS_LIMIT) {
		this.limit = limit;
	}

	/**
	 * Records a finished intent call. Untracked, so an intent called inside
	 * an `$effect` doesn't make it depend on the buffer it writes (the
	 * intents client also runs the whole call untracked).
	 *
	 * @mutates this.entries - appends the entry, dropping the oldest past `limit`
	 */
	record(
		spec: IntentActionSpec,
		input: unknown,
		outcome: RecentIntent['outcome'],
		error: string | null = null
	): RecentIntent {
		const entry: RecentIntent = {
			seq: ++this.#seq,
			method: spec.method,
			version: spec.version,
			history: spec.history,
			input,
			at: Date.now(),
			outcome,
			error,
			inverse: null
		};
		untrack(() => {
			const next = this.entries.length < this.limit ? this.entries.slice() : this.entries.slice(1);
			next.push(entry);
			this.entries = next;
		});
		return entry;
	}

	/** @mutates this.entries - empties it */
	clear(): void {
		this.entries = [];
	}
}
