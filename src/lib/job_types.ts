import { z } from 'zod';
import { Uuid } from '@fuzdev/fuz_util/id.ts';

import { DiskfilePath } from './diskfile_types.ts';

/** What a job does. */
export const JobKind = z.enum(['transcription']);
export type JobKind = z.infer<typeof JobKind>;

/** Where a job is in its life. The last three are final. */
export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

/**
 * A job as the backend reports it: long-running work on a file that outlives
 * the request that started it. Twin of the backend's `JobSnapshot`.
 */
export const JobSnapshot = z.strictObject({
	job_id: Uuid,
	kind: JobKind,
	status: JobStatus,
	/** How far along a running job is, 0 to 1 — `null` when unknown. */
	progress: z.number().nullable(),
	/** The file the job works on. */
	input_path: DiskfilePath,
	/** The file the job wrote, once it succeeded. */
	output_path: DiskfilePath.nullable(),
	/** The command lines run so far, in order, for display. */
	commands: z.array(z.string()),
	/** Milliseconds since the epoch. */
	queued_at: z.number(),
	started_at: z.number().nullable(),
	ended_at: z.number().nullable(),
	/** Why a failed job failed. */
	error: z.string().nullable(),
	/** The tail of the failing tool's stderr — derived from the input file, so render it as text. */
	stderr: z.string()
});
export type JobSnapshot = z.infer<typeof JobSnapshot>;

/** Whether a job in `status` is over. */
export const is_job_finished = (status: JobStatus): boolean =>
	status === 'succeeded' || status === 'failed' || status === 'cancelled';
