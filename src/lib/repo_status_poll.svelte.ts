/**
 * Polls `project_status` for one open registry project while something
 * shows it.
 *
 * Each poll answers at once with what the daemon knows and starts probes of
 * the stale entries (the daemon's `repo_status` module), so a poll soon
 * after one that left probes running picks up their results:
 * `POLL_PROBING_MS` while any entry is probing, `POLL_IDLE_MS` otherwise —
 * the idle polls are what notice a commit or an edit, and what drive the
 * daemon's slow sweep. A view-scoped helper, not a cell: nothing persists
 * it, and it lives only as long as the component that started it.
 *
 * @module
 */

import type { Result } from '@fuzdev/fuz_util/result.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import type {
	ProjectStatusInput,
	ProjectStatusOutput,
	RepoRelationJson,
	RepoStatusJson
} from './action_specs.ts';
import type { DiskfileDirectoryPath } from './diskfile_types.ts';

/** How soon to poll again while an entry is probing. */
export const POLL_PROBING_MS = 1000;

/** How soon to poll again once nothing is probing. */
export const POLL_IDLE_MS = 4000;

/** The `project_status` call, as `app.api` makes it. */
export type FetchProjectStatus = (
	input: ProjectStatusInput
) => Promise<Result<{ value: ProjectStatusOutput }, { error: { message: string } }>>;

/** What a `RepoStatusPoll` polls, and how. */
export interface RepoStatusPollOptions {
	root: DiskfileDirectoryPath;
	fetch_status: FetchProjectStatus;
}

/**
 * The statuses of one registry's entries, kept fresh while started: stopped
 * and started again as its view hides and shows, keeping what it last read.
 */
export class RepoStatusPoll {
	readonly root: DiskfileDirectoryPath;

	/** The latest status of each entry, by registry key; refused entries are absent. */
	statuses: ReadonlyMap<string, RepoStatusJson> = $state.raw(new Map());

	/** Why the last poll failed, if it did. */
	error: string | null = $state.raw(null);

	readonly probing: boolean = $derived.by(() => {
		for (const status of this.statuses.values()) if (status.probing) return true;
		return false;
	});

	readonly #fetch_status: FetchProjectStatus;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#running = false;
	/** Bumped by every `stop`, so a reply that lands after one is dropped. */
	#generation = 0;
	/** Each call's number, so a reply older than one applied is dropped. */
	#sent = 0;
	#applied = 0;

	constructor(options: RepoStatusPollOptions) {
		this.root = options.root;
		this.#fetch_status = options.fetch_status;
	}

	/** Start polling, now and then on the cadence; a no-op when running. */
	start(): void {
		if (this.#running) return;
		this.#running = true;
		void this.#poll(false);
	}

	/** Stop polling; a reply in flight is dropped. */
	stop(): void {
		this.#running = false;
		this.#generation++;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
	}

	/** Ask the daemon to re-probe every entry now, then keep polling. */
	refresh(): void {
		if (!this.#running) return;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		void this.#poll(true);
	}

	async #poll(refresh: boolean): Promise<void> {
		const generation = this.#generation;
		const seq = ++this.#sent;
		let ok = false;
		let error: string | null = null;
		let entries: Array<RepoStatusJson> | null = null;
		try {
			const result = await this.#fetch_status(
				refresh ? { root: this.root, refresh: true } : { root: this.root }
			);
			if (result.ok) {
				ok = true;
				entries = result.value.entries;
			} else {
				error = result.error.message;
			}
		} catch (e) {
			error = to_error_message(e);
		}
		// a stop since bumped the generation
		if (generation !== this.#generation) return;
		// a refresh's reply can land before the poll it overtook: the older one
		// neither applies nor schedules, the newer did both
		if (seq < this.#applied) return;
		this.#applied = seq;
		this.error = error;
		if (entries) this.statuses = new Map(entries.map((entry) => [entry.key, entry]));
		// a refresh may land while an earlier poll's timer is set: one timer only
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = setTimeout(
			() => {
				this.#timer = null;
				void this.#poll(false);
			},
			// failing polls keep the idle pace, whatever the last statuses say
			ok && this.probing ? POLL_PROBING_MS : POLL_IDLE_MS
		);
	}
}

/** What a followed branch's relation says beyond its counts, when anything. */
const RELATION_LABELS: Partial<Record<RepoRelationJson['kind'], string>> = {
	gone: 'upstream gone',
	untracked: 'no upstream',
	unmapped: 'upstream unmapped',
	shallow: 'shallow'
};

/** A status's snake_case kind (`needs_human`, `in_progress`) as a person reads it. */
export const format_status_kind = (kind: string): string => kind.replaceAll('_', ' ');

/**
 * A status's short summary for a listing: the branch when it isn't the one
 * followed, the operation in progress, the uncommitted counts, the followed
 * branch's distance from origin, stashes. Empty when it's at rest.
 */
export const format_repo_status = (status: RepoStatusJson): string => {
	const parts: Array<string> = [];
	// a reference following no branch (`on_branch` null) is left wherever it
	// is, detached included: nothing to say
	if (status.on_branch === false) {
		parts.push(status.detached ? 'detached' : `on ${status.branch}`);
	}
	if (status.in_progress) parts.push(format_status_kind(status.in_progress));
	const u = status.uncommitted;
	if (u.conflicted) parts.push(`${u.conflicted} conflicted`);
	if (u.staged) parts.push(`${u.staged} staged`);
	if (u.unstaged) parts.push(`${u.unstaged} modified`);
	if (u.untracked) parts.push(`${u.untracked} untracked`);
	const f = status.followed;
	if (f) {
		if (f.ahead) parts.push(`${f.ahead} ahead`);
		if (f.behind) parts.push(`${f.behind} behind`);
		const kind_label = RELATION_LABELS[f.kind];
		if (kind_label) parts.push(kind_label);
	}
	if (status.stashes) parts.push(`${status.stashes} stashed`);
	return parts.join(', ');
};
