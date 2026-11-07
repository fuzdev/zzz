import {
	array,
	nullable,
	number,
	object,
	one_of,
	string,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';
import { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { DiskfilePath } from './diskfile_types.ts';

/** What a job does. */
export const JobKind = one_of(['transcription']);
export type JobKind = Infer<typeof JobKind>;

/** Where a job is in its life. The last three are final. */
export const JobStatus = one_of(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = Infer<typeof JobStatus>;

/**
 * A job as the backend reports it: long-running work on a file that outlives
 * the request that started it. Twin of the backend's `JobSnapshot`.
 */
export const JobSnapshot = object({
	job_id: Uuid,
	kind: JobKind,
	status: JobStatus,
	/** How far along a running job is, 0 to 1 — `null` when unknown. */
	progress: nullable(number),
	/** The file the job works on. */
	input_path: DiskfilePath,
	/** The file the job wrote, once it succeeded. */
	output_path: nullable(DiskfilePath),
	/** The command lines run so far, in order, for display. */
	commands: array(string),
	/** Milliseconds since the epoch. */
	queued_at: number,
	started_at: nullable(number),
	ended_at: nullable(number),
	/** Why a failed job failed. */
	error: nullable(string),
	/** The tail of the failing tool's stderr — derived from the input file, so render it as text. */
	stderr: string
});
export type JobSnapshot = Infer<typeof JobSnapshot>;

/** Whether a job in `status` is over. */
export const is_job_finished = (status: JobStatus): boolean =>
	status === 'succeeded' || status === 'failed' || status === 'cancelled';
