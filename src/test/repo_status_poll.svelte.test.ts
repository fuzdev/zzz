import { afterEach, assert, beforeEach, describe, test, vi } from 'vitest';

import type { ProjectStatusInput, RepoStatusJson } from '#lib/action_specs.ts';
import type { DiskfileDirectoryPath } from '#lib/diskfile_types.ts';
import {
	format_repo_status,
	POLL_IDLE_MS,
	POLL_PROBING_MS,
	RepoStatusPoll,
	type FetchProjectStatus
} from '#lib/repo_status_poll.svelte.ts';

const ROOT = '/home/me/dev/' as DiskfileDirectoryPath;

const status = (overrides: Partial<RepoStatusJson> = {}): RepoStatusJson => ({
	key: 'app',
	state: 'ok',
	probing: false,
	probed_at: 1,
	branch: 'main',
	detached: false,
	on_branch: true,
	uncommitted: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
	in_progress: null,
	followed: { kind: 'in_sync', ahead: 0, behind: 0 },
	stashes: 0,
	fetched_at: null,
	needs_human: [],
	error: null,
	...overrides
});

/** A fake `project_status` answering from `replies`, the last one repeated. */
const create_fetch = (replies: Array<Array<RepoStatusJson>>) => {
	const calls: Array<ProjectStatusInput> = [];
	const fetch_status: FetchProjectStatus = (input) => {
		calls.push(input);
		const entries = replies.length > 1 ? replies.shift()! : replies[0]!;
		return Promise.resolve({ ok: true, value: { entries } });
	};
	return { calls, fetch_status };
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('RepoStatusPoll', () => {
	test('polls fast while an entry is probing, then at the idle pace', async () => {
		const { calls, fetch_status } = create_fetch([
			[status({ state: 'pending', probing: true })],
			[status()]
		]);
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(calls.length, 1);
		assert.ok(poll.probing);

		await vi.advanceTimersByTimeAsync(POLL_PROBING_MS);
		assert.strictEqual(calls.length, 2);
		assert.ok(!poll.probing);
		assert.strictEqual(poll.statuses.get('app')?.state, 'ok');

		await vi.advanceTimersByTimeAsync(POLL_IDLE_MS - 1);
		assert.strictEqual(calls.length, 2, 'idle: not yet');
		await vi.advanceTimersByTimeAsync(1);
		assert.strictEqual(calls.length, 3);
		poll.stop();
	});

	test('refresh asks for a re-probe at once, keeping one timer', async () => {
		const { calls, fetch_status } = create_fetch([[status()]]);
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		await vi.advanceTimersByTimeAsync(0);
		poll.refresh();
		await vi.advanceTimersByTimeAsync(0);
		assert.deepEqual(calls, [{ root: ROOT }, { root: ROOT, refresh: true }]);
		await vi.advanceTimersByTimeAsync(POLL_IDLE_MS);
		assert.strictEqual(calls.length, 3, 'one poll per idle interval, not two');
		poll.stop();
	});

	test('stop drops a reply in flight and polls no more', async () => {
		let answer!: (entries: Array<RepoStatusJson>) => void;
		const fetch_status: FetchProjectStatus = () =>
			new Promise((resolve) => {
				answer = (entries) => resolve({ ok: true, value: { entries } });
			});
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		poll.stop();
		answer([status()]);
		await vi.advanceTimersByTimeAsync(POLL_IDLE_MS * 2);
		assert.strictEqual(poll.statuses.size, 0);
		assert.strictEqual(vi.getTimerCount(), 0);
	});

	test('a failed poll keeps the last statuses and says why', async () => {
		let fail = false;
		const fetch_status: FetchProjectStatus = () =>
			Promise.resolve(
				fail
					? { ok: false, error: { message: 'project_not_open' } }
					: { ok: true, value: { entries: [status()] } }
			);
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		await vi.advanceTimersByTimeAsync(0);
		fail = true;
		await vi.advanceTimersByTimeAsync(POLL_IDLE_MS);
		assert.strictEqual(poll.error, 'project_not_open');
		assert.strictEqual(poll.statuses.get('app')?.state, 'ok');
		poll.stop();
	});
});

describe('RepoStatusPoll, its guards one by one', () => {
	/** A fake whose replies are resolved by hand, in any order. */
	const create_manual = () => {
		const pending: Array<{
			input: ProjectStatusInput;
			resolve: (entries: Array<RepoStatusJson>) => void;
			reject: (e: unknown) => void;
		}> = [];
		const fetch_status: FetchProjectStatus = (input) =>
			new Promise((resolve, reject) => {
				pending.push({
					input,
					resolve: (entries) => resolve({ ok: true, value: { entries } }),
					reject
				});
			});
		return { pending, fetch_status };
	};

	test('a refresh while the first poll is in flight leaves one timer', async () => {
		const { pending, fetch_status } = create_manual();
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		poll.refresh();
		pending[0]!.resolve([status()]);
		pending[1]!.resolve([status()]);
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(vi.getTimerCount(), 1);
		poll.stop();
	});

	test('a refresh cancels the pending poll, sending no extra one while in flight', async () => {
		const { pending, fetch_status } = create_manual();
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		pending[0]!.resolve([status()]);
		await vi.advanceTimersByTimeAsync(POLL_IDLE_MS - 10);
		poll.refresh();
		await vi.advanceTimersByTimeAsync(20);
		assert.strictEqual(pending.length, 2, 'the idle timer was cancelled');
		poll.stop();
	});

	test('a reply from before a stop and restart is dropped', async () => {
		const { pending, fetch_status } = create_manual();
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		poll.stop();
		poll.start();
		pending[0]!.resolve([status({ branch: 'old' })]);
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(poll.statuses.size, 0, 'the old reply is dropped');
		pending[1]!.resolve([status()]);
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(poll.statuses.get('app')?.branch, 'main');
		poll.stop();
	});

	test('an older reply landing after a newer one is dropped', async () => {
		const { pending, fetch_status } = create_manual();
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		poll.refresh();
		const dirty = { staged: 0, unstaged: 2, untracked: 0, conflicted: 0 };
		pending[1]!.resolve([status({ uncommitted: dirty })]);
		await vi.advanceTimersByTimeAsync(0);
		pending[0]!.resolve([status()]);
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(poll.statuses.get('app')?.uncommitted.unstaged, 2);
		assert.strictEqual(vi.getTimerCount(), 1);
		poll.stop();
	});

	test('a thrown fetch is an error, and polling goes on', async () => {
		const { pending, fetch_status } = create_manual();
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		pending[0]!.reject(Error('socket closed'));
		await vi.advanceTimersByTimeAsync(0);
		assert.strictEqual(poll.error, 'socket closed');
		await vi.advanceTimersByTimeAsync(POLL_IDLE_MS);
		assert.strictEqual(pending.length, 2);
		poll.stop();
	});

	test('failing polls keep the idle pace though the last statuses were probing', async () => {
		let fail = false;
		let calls = 0;
		const fetch_status: FetchProjectStatus = () => {
			calls++;
			return Promise.resolve(
				fail
					? { ok: false, error: { message: 'project_not_open' } }
					: { ok: true, value: { entries: [status({ probing: true })] } }
			);
		};
		const poll = new RepoStatusPoll({ root: ROOT, fetch_status });
		poll.start();
		await vi.advanceTimersByTimeAsync(0);
		fail = true;
		await vi.advanceTimersByTimeAsync(POLL_PROBING_MS);
		assert.strictEqual(calls, 2);
		await vi.advanceTimersByTimeAsync(POLL_IDLE_MS - 1);
		assert.strictEqual(calls, 2, 'not the probing pace');
		poll.stop();
	});
});

describe('format_repo_status', () => {
	test('a repo at rest has nothing to say', () => {
		assert.strictEqual(format_repo_status(status()), '');
	});

	test('says what differs from rest, in order', () => {
		assert.strictEqual(
			format_repo_status(
				status({
					on_branch: false,
					branch: 'wip',
					in_progress: 'rebase',
					uncommitted: { staged: 1, unstaged: 2, untracked: 3, conflicted: 4 },
					followed: { kind: 'diverged', ahead: 5, behind: 6 },
					stashes: 7
				})
			),
			'on wip, rebase in progress, 1 staged, 2 unstaged, 3 untracked, 4 conflicted, diverged +5 −6, stashes 7'
		);
		assert.strictEqual(
			format_repo_status(status({ detached: true, branch: null, on_branch: false })),
			'detached'
		);
		assert.strictEqual(
			format_repo_status(status({ detached: true, branch: null, on_branch: null, followed: null })),
			'',
			'a reference following no branch is at rest wherever it is'
		);
		assert.strictEqual(
			format_repo_status(status({ followed: { kind: 'untracked', ahead: 0, behind: 0 } })),
			'no upstream'
		);
		assert.strictEqual(
			format_repo_status(status({ followed: { kind: 'unmapped', ahead: 0, behind: 0 } })),
			'outside refspec'
		);
		assert.strictEqual(
			format_repo_status(status({ followed: { kind: 'shallow', ahead: 0, behind: 0 } })),
			'shallow, tips differ'
		);
		assert.strictEqual(
			format_repo_status(status({ followed: { kind: 'ahead', ahead: 3, behind: 0 } })),
			'ahead 3'
		);
		assert.strictEqual(
			format_repo_status(status({ followed: { kind: 'behind', ahead: 0, behind: 2 } })),
			'behind 2'
		);
		assert.strictEqual(
			format_repo_status(status({ in_progress: 'cherry_pick' })),
			'cherry pick in progress'
		);
		assert.strictEqual(
			format_repo_status(status({ followed: { kind: 'gone', ahead: 0, behind: 0 } })),
			'upstream gone'
		);
	});

	test('names why repos sync would leave it to a person, inline, not what the line already says', () => {
		assert.strictEqual(
			format_repo_status(
				status({
					in_progress: 'merge',
					needs_human: ['origin_mismatch', 'some_new_reason']
				})
			),
			'merge in progress, origin mismatch, some new reason'
		);
	});

	test('a worktree operation shows by its reason; a followed relation is said once', () => {
		assert.strictEqual(
			format_repo_status(status({ needs_human: ['operation_in_progress'] })),
			'operation in progress in a worktree'
		);
		assert.strictEqual(
			format_repo_status(status({ in_progress: 'merge', needs_human: ['operation_in_progress'] })),
			'merge in progress, operation in progress in a worktree',
			"the primary's and a worktree's, both said"
		);
		assert.strictEqual(
			format_repo_status(
				status({
					followed: { kind: 'gone', ahead: 0, behind: 0 },
					needs_human: ['default_branch_gone']
				})
			),
			'upstream gone'
		);
		assert.strictEqual(
			format_repo_status(
				status({
					followed: { kind: 'untracked', ahead: 0, behind: 0 },
					needs_human: ['default_branch_no_upstream']
				})
			),
			'no upstream'
		);
		assert.strictEqual(
			format_repo_status(status({ followed: null, needs_human: ['default_branch_gone'] })),
			"default branch's upstream gone",
			'without a followed relation, the reason is the only signal'
		);
		assert.strictEqual(
			format_repo_status(status({ needs_human: ['constructor'] })),
			'constructor',
			'an unknown kind, never an object built-in'
		);
	});
});
