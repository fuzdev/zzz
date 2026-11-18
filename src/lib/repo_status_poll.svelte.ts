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

/**
 * What a followed branch's relation says beyond its counts, when anything —
 * `repos status`'s words, but for `untracked`, which here would read as
 * untracked files.
 */
const RELATION_LABELS: Partial<Record<RepoRelationJson['kind'], string>> = {
	gone: 'upstream gone',
	untracked: 'no upstream',
	unmapped: 'outside refspec',
	shallow: 'shallow, tips differ'
};

/**
 * Why `repos sync` would leave a repo to a person, by `needs_human` kind,
 * in `repos status`'s words as far as the kind alone says them (the wire
 * carries no URL or branch). `null` for a reason the line always shows
 * otherwise: a detached HEAD, not a repo; `format_repo_status` drops a
 * reason the line's other parts already say (`is_said_already`).
 */
const NEEDS_HUMAN_LABELS: Record<string, string | null> = {
	not_a_repo: null,
	operation_in_progress: 'operation in progress in a worktree',
	unexpected_detached: null,
	origin_mismatch: 'origin mismatch',
	origin_not_https: 'origin not over HTTPS',
	fetch_url_mismatch: 'fetch URL mismatch',
	push_url_mismatch: 'push URL mismatch',
	worktree_unreadable: 'worktree unreadable',
	default_branch_missing: 'no local default branch',
	default_branch_no_upstream: 'default branch has no origin upstream',
	default_branch_gone: "default branch's upstream gone",
	checkout_unresolvable: 'checkout unresolvable',
	unlisted_git_dir: 'unlisted git dir',
	clone_shares_repo: 'same repo as another entry',
	cloned_unregistered: 'already cloned under another name'
};

/** A status's snake_case kind (`in_progress`, an unknown `needs_human`) as a person reads it. */
const format_status_kind = (kind: string): string => kind.replaceAll('_', ' ');

/**
 * A status's short summary for a listing, in `repos status`'s words: the
 * branch when it isn't the one followed, the operation in progress, the
 * uncommitted counts, the followed branch's distance from origin, stashes,
 * and why `repos sync` would leave it to a person. Empty when it's at rest.
 */
export const format_repo_status = (status: RepoStatusJson): string => {
	const parts: Array<string> = [];
	// a reference following no branch (`on_branch` null) is left wherever it
	// is, detached included: nothing to say
	if (status.on_branch === false) {
		parts.push(status.detached ? 'detached' : `on ${status.branch}`);
	}
	if (status.in_progress) parts.push(`${format_status_kind(status.in_progress)} in progress`);
	const u = status.uncommitted;
	if (u.staged) parts.push(`${u.staged} staged`);
	if (u.unstaged) parts.push(`${u.unstaged} unstaged`);
	if (u.untracked) parts.push(`${u.untracked} untracked`);
	if (u.conflicted) parts.push(`${u.conflicted} conflicted`);
	const f = status.followed;
	if (f) {
		if (f.kind === 'diverged') parts.push(`diverged +${f.ahead} −${f.behind}`);
		else if (f.ahead) parts.push(`ahead ${f.ahead}`);
		else if (f.behind) parts.push(`behind ${f.behind}`);
		const kind_label = RELATION_LABELS[f.kind];
		if (kind_label) parts.push(kind_label);
	}
	if (status.stashes) parts.push(`stashes ${status.stashes}`);
	for (const kind of status.needs_human) {
		if (is_said_already(kind, status)) continue;
		const label = Object.hasOwn(NEEDS_HUMAN_LABELS, kind)
			? NEEDS_HUMAN_LABELS[kind]
			: format_status_kind(kind);
		if (label) parts.push(label);
	}
	return parts.join(', ');
};

/**
 * Whether the line's other parts already say what the `needs_human` `kind`
 * does: the followed branch's upstream gone or absent (its relation; a
 * reference following no branch has only the reason). The primary
 * checkout's operation never arrives as a reason — the daemon drops it for
 * `in_progress` — so `operation_in_progress` is always a linked worktree's.
 */
const is_said_already = (kind: string, status: RepoStatusJson): boolean => {
	switch (kind) {
		case 'default_branch_gone':
			return status.followed?.kind === 'gone';
		case 'default_branch_no_upstream':
			return status.followed?.kind === 'untracked';
		default:
			return false;
	}
};
