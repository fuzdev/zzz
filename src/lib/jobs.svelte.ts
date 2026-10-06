import { z } from 'zod';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { CellJson } from './cell_types.ts';
import { IndexedCollection } from './indexed_collection.svelte.ts';
import { create_single_index } from './indexed_collection_helpers.svelte.ts';
import { Job } from './job.svelte.ts';
import type { JobSnapshot } from './job_types.ts';
import type { DiskfilePath } from './diskfile_types.ts';
import type { TranscriptSegment } from './transcript_types.ts';

export const JobsJson = CellJson.extend({}).meta({ cell_class_name: 'Jobs' });
export type JobsJson = z.infer<typeof JobsJson>;
export type JobsJsonInput = z.input<typeof JobsJson>;

export interface JobsOptions extends CellOptions<typeof JobsJson> {}

/**
 * App-level collection of the account's jobs, mirroring the backend's: jobs
 * live in the daemon's memory, so this holds nothing of its own. `job_changed`
 * notifications keep it current (`receive_changed`), and each session
 * snapshot replaces it (`reconcile`) — after a daemon restart that's empty.
 */
export class Jobs extends Cell<typeof JobsJson> {
	readonly items: IndexedCollection<Job> = new IndexedCollection({
		dispose_item: (job) => job.dispose(),
		indexes: [
			create_single_index({
				key: 'by_job_id',
				extractor: (job) => job.job_id,
				immutable_key: true
			})
		]
	});

	/** Jobs newest first, by when they were queued. */
	readonly newest_first: Array<Job> = $derived(
		this.items.values.toSorted((a, b) => b.queued_at - a.queued_at)
	);

	/** Jobs that are queued or running. */
	readonly unfinished: Array<Job> = $derived(this.items.values.filter((job) => !job.finished));

	constructor(options: JobsOptions) {
		super(JobsJson, options);
		this.init();
	}

	get_by_job_id(job_id: Uuid): Job | undefined {
		return this.items.by_optional('by_job_id', job_id);
	}

	/**
	 * The newest job working on the file at `path`, if any — the one whose
	 * state a view of that file shows.
	 */
	latest_for_input(path: DiskfilePath): Job | undefined {
		let latest: Job | undefined;
		for (const job of this.items.values) {
			if (job.input_path === path && (!latest || job.queued_at > latest.queued_at)) latest = job;
		}
		return latest;
	}

	/** Applies a `job_changed` notification: adds the job, or updates it in place. */
	receive_changed(snapshot: JobSnapshot): Job {
		const existing = this.get_by_job_id(snapshot.job_id);
		if (existing) {
			existing.set_json_partial(snapshot);
			return existing;
		}
		const job = new Job({ app: this.app, json: snapshot });
		this.items.add(job);
		return job;
	}

	/**
	 * Applies a `transcription_progress` notification: appends the segments to
	 * the job's preview. Segments for a job this app hasn't heard of are
	 * dropped — its `job_changed` always comes first.
	 */
	receive_transcription_progress(job_id: Uuid, segments: ReadonlyArray<TranscriptSegment>): void {
		const job = this.get_by_job_id(job_id);
		if (!job || segments.length === 0) return;
		job.live_segments = [...job.live_segments, ...segments];
	}

	/**
	 * Replaces the collection with a session snapshot's jobs: listed jobs are
	 * added or updated, and ones the backend no longer has — it restarted, or
	 * dropped them from its history — are removed.
	 */
	reconcile(snapshots: ReadonlyArray<JobSnapshot>): void {
		const listed: Set<Uuid> = new Set();
		for (const snapshot of snapshots) {
			listed.add(snapshot.job_id);
			this.receive_changed(snapshot);
		}
		for (const job of this.items.values.slice()) {
			if (!listed.has(job.job_id)) this.items.remove(job.id);
		}
	}

	/**
	 * Queues a transcription of the audio file at `path` (`transcription_create`).
	 * The job arrives through `job_changed`.
	 *
	 * @param path - the audio file
	 * @param language - a language code, or omitted to detect it
	 * @returns the job's id, or the RPC error
	 */
	async transcribe(
		path: DiskfilePath,
		language?: string
	): Promise<Result<{ value: { job_id: Uuid } }, { error: JsonrpcErrorObject }>> {
		return this.app.api.transcription_create(
			language === undefined ? { path } : { path, language }
		);
	}

	/**
	 * Cancels a job (`job_cancel`). Its `job_changed` carries the outcome.
	 *
	 * @returns the RPC result — `not_found` when the backend no longer has it
	 */
	async cancel(job: Job): Promise<Result<{ value: null }, { error: JsonrpcErrorObject }>> {
		return this.app.api.job_cancel({ job_id: job.job_id });
	}
}
