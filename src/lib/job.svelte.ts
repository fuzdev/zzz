import {
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';

import { Cell, type CellOptions } from './cell.svelte.ts';
import { cell_json_schema } from './cell_types.ts';
import { JobSnapshot, is_job_finished, type JobKind, type JobStatus } from './job_types.ts';
import type { DiskfilePath } from './diskfile_types.ts';
import type { TranscriptSegment } from './transcript_types.ts';

const { def: shape } = JobSnapshot;

/**
 * A `JobSnapshot` as a cell. What identifies a job — its id, kind, input, and
 * when it was queued — stays required; the rest defaults to a job that hasn't
 * started.
 */
export const JobJson = cell_json_schema(
	{
		job_id: shape.job_id,
		kind: shape.kind,
		input_path: shape.input_path,
		queued_at: shape.queued_at,
		status: with_default(shape.status, 'queued'),
		progress: with_default(shape.progress, null),
		output_path: with_default(shape.output_path, null),
		commands: with_default_fn(shape.commands, () => []),
		started_at: with_default(shape.started_at, null),
		ended_at: with_default(shape.ended_at, null),
		error: with_default(shape.error, null),
		stderr: with_default(shape.stderr, '')
	},
	'Job'
);
export type JobJson = Infer<typeof JobJson>;
export type JobJsonInput = InferInput<typeof JobJson>;

export interface JobOptions extends CellOptions<typeof JobJson> {}

/**
 * A job on the backend: long-running work on a file — a transcription — that
 * outlives the request that started it. Mirrors the backend's state: every
 * `job_changed` notification replaces these fields (`Jobs.receive_changed`).
 */
export class Job extends Cell<typeof JobJson> {
	job_id: JobJson['job_id'] = $state.raw()!;
	kind: JobKind = $state.raw()!;
	status: JobStatus = $state.raw()!;
	progress: number | null = $state.raw()!;
	input_path: DiskfilePath = $state.raw()!;
	output_path: DiskfilePath | null = $state.raw()!;
	commands: Array<string> = $state.raw()!;
	queued_at: number = $state.raw()!;
	started_at: number | null = $state.raw()!;
	ended_at: number | null = $state.raw()!;
	error: string | null = $state.raw()!;
	stderr: string = $state.raw()!;

	/**
	 * The segments a running transcription has decoded so far — a preview, in
	 * the order they arrived. Not part of the job's state on the backend: a
	 * reload starts it empty, and the transcript file is the result.
	 */
	live_segments: Array<TranscriptSegment> = $state.raw([]);

	readonly finished: boolean = $derived(is_job_finished(this.status));

	/** Whether the job can still be cancelled. */
	readonly cancellable: boolean = $derived(!this.finished);

	/** How long the job ran, in milliseconds — `null` until it has ended. */
	readonly run_duration: number | null = $derived(
		this.started_at !== null && this.ended_at !== null ? this.ended_at - this.started_at : null
	);

	constructor(options: JobOptions) {
		super(JobJson, options);
		this.init();
	}
}
