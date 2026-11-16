import {
	array,
	boolean,
	check,
	integer,
	literal,
	loose_object,
	max_value,
	message,
	min_value,
	nullable,
	number,
	object,
	one_of,
	optional,
	pipe,
	safe_integer,
	string,
	void as fuz_void,
	with_default,
	with_default_fn,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';
import { Blake3Hash, Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import { JsonrpcRequestId } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import type {
	LocalCallActionSpec,
	RemoteNotificationActionSpec,
	RequestResponseActionSpec,
	ActionSpecUnion
} from '@fuzdev/fuz_app/actions/action_spec.ts';
import { heartbeat_action_spec } from '@fuzdev/fuz_app/actions/heartbeat.ts';
import { cancel_action_spec } from '@fuzdev/fuz_app/actions/cancel.ts';
import { peer_ping_action_spec } from '@fuzdev/fuz_app/actions/peer_ping.ts';
import { protocol_action_specs } from '@fuzdev/fuz_app/actions/protocol.ts';

// Re-export so codegen (which builds `import * as specs from './action_specs'`)
// resolves `specs.heartbeat_action_spec` / `specs.cancel_action_spec` /
// `specs.peer_ping_action_spec` via the namespace lookup (the `peer/ping`
// method's spec identifier sanitizes to `peer_ping_action_spec`). The runtime
// array `all_action_specs` references each spec once via `protocol_action_specs`;
// the re-exports are name aliases only — nothing is duplicated at runtime. A
// `create_protocol_aware_qualifier`-style helper in fuz_app could eliminate this
// enumeration; tracked as a follow-up.
export { heartbeat_action_spec, cancel_action_spec, peer_ping_action_spec };

import {
	DiskfileChange,
	DiskfileDirectoryPath,
	DiskfilePath,
	DiskfileUnloadedReason,
	SerializableDisknode
} from './diskfile_types.ts';
import { ERROR_INVALID_PATH, is_path_absolute } from './diskfile_helpers.ts';
import { ERROR_TERMINAL_COMMAND_NOT_FOUND } from './terminal_helpers.ts';
import { ProviderStatus, ProviderName } from './provider_types.ts';
import { JobSnapshot } from './job_types.ts';
import { TranscriptSegment } from './transcript_types.ts';
import { CompletionMessage, CompletionRequest, CompletionResponse } from './completion_types.ts';
import { ProjectInfoJson, ProjectWatchStatus } from './project.svelte.ts';

// -- Shared sub-schemas -----------------------------------------------------

/**
 * Progress-token envelope shared by streaming actions. Carries the caller's
 * `progressToken` so streamed `*_progress` notifications can be correlated
 * with the originating request. `loose_object` lets transports tack on
 * additional MCP-style metadata without a schema bump.
 */
export const ProgressMeta = loose_object({ progressToken: optional(Uuid) });
export type ProgressMeta = Infer<typeof ProgressMeta>;

// -- Input/output schemas ---------------------------------------------------

/**
 * Output for `ping`. Echoes the JSON-RPC request id back as `ping_id`.
 * A fuz_schema `object` (refuses unknown keys), since it embeds fuz_app's
 * fuz_schema `JsonrpcRequestId`.
 */
export const PingOutput = object({
	ping_id: JsonrpcRequestId
});
export type PingOutput = Infer<typeof PingOutput>;

/**
 * Inner payload of `session_load`. The fields here are the actual session
 * snapshot — files and the roots they cover, scoped dirs, provider status,
 * projects, the caller's terminals, and the server instance. The frontend
 * loads it at boot and again after every reconnect, reconciling its state to
 * it (see `Frontend.load_session`).
 *
 * TODO extract to `diskfile_types.ts` (or a session-specific module) once
 * the Rust backend grows its own typed session response and we can move
 * this schema to the shared boundary.
 */
export const SessionLoadData = object({
	zzz_dir: DiskfileDirectoryPath,
	scoped_dirs: array(DiskfileDirectoryPath),
	files: array(SerializableDisknode),
	/**
	 * The roots of the backend's permanent filers and the ones the open
	 * projects keep, each covered by `files` as deep as its filer indexes — a
	 * whole tree, or a registry root's top level alone. A known file under one
	 * of them that `files` lacks is no longer indexed: gone from disk, or in a
	 * repo under a registry root that isn't focused.
	 */
	file_roots: array(DiskfileDirectoryPath),
	provider_status: array(ProviderStatus),
	projects: array(ProjectInfoJson),
	/** Backend ids of the caller's live terminals. */
	terminal_ids: array(Uuid),
	/** The caller's jobs, oldest first — running, queued, and recent finished ones. */
	jobs: array(JobSnapshot),
	/**
	 * Minted each time the backend starts — a different id than the last
	 * snapshot's means it restarted, losing its terminals and open projects.
	 */
	server_instance_id: Uuid
});
export type SessionLoadData = Infer<typeof SessionLoadData>;

/**
 * Output for `session_load`. The `data` wrapper is historical; the Rust
 * backend serializes this exact shape (`SessionLoadResult` in
 * `crates/zzz_server`), so flattening it is a coordinated wire change on
 * both sides.
 */
export const SessionLoadOutput = object({
	data: SessionLoadData
});
export type SessionLoadOutput = Infer<typeof SessionLoadOutput>;

/**
 * Input for `filer_change`: the change, and the file's disknode — its
 * metadata, without its contents.
 */
export const FilerChangeInput = object({
	change: DiskfileChange,
	disknode: SerializableDisknode
});
export type FilerChangeInput = Infer<typeof FilerChangeInput>;

/** Input for `diskfile_read`. */
export const DiskfileReadInput = object({
	path: DiskfilePath
});
export type DiskfileReadInput = Infer<typeof DiskfileReadInput>;

/**
 * Output for `diskfile_read`. `contents` is `null` exactly when
 * `unloaded_reason` says why, and `hash` is `null` with it: otherwise it's
 * the BLAKE3 of the bytes read (bare lowercase hex) — what a save based on
 * these contents sends back as `diskfile_update`'s `expected_hash`. `size`
 * is in bytes: the contents' length when
 * they're loaded, the bytes read when they aren't UTF-8, and for a file too
 * large, its size when opened — or the limit plus one byte, a lower bound,
 * for one that grew past the limit during the read. `ctime` /
 * `mtime` are a disknode's (milliseconds since the epoch, `null` when the
 * backend couldn't say), taken before the read, so a write racing it leaves
 * them older than the contents, never newer.
 */
export const DiskfileReadOutput = object({
	contents: nullable(string),
	unloaded_reason: nullable(DiskfileUnloadedReason),
	hash: nullable(Blake3Hash),
	size: number,
	ctime: nullable(number),
	mtime: nullable(number)
});
export type DiskfileReadOutput = Infer<typeof DiskfileReadOutput>;

/**
 * Input for `diskfile_update`. `expected_hash` makes the save a
 * compare-and-swap: the `hash` of the `diskfile_read` the edit is based on,
 * and the file is written only if it still holds those bytes — else
 * `conflict` / `disk_changed`, nothing written. Omitted, the save writes
 * whatever is on disk: recreating a deleted file, or forcing a write the
 * client can't base on a read.
 */
export const DiskfileUpdateInput = object({
	path: DiskfilePath,
	content: string,
	expected_hash: optional(Blake3Hash)
});
export type DiskfileUpdateInput = Infer<typeof DiskfileUpdateInput>;

/**
 * Output for `diskfile_update`: the BLAKE3 of the bytes written, in
 * `diskfile_read`'s `hash` form — the base of the next save, with no read
 * in between.
 */
export const DiskfileUpdateOutput = object({
	hash: Blake3Hash
});
export type DiskfileUpdateOutput = Infer<typeof DiskfileUpdateOutput>;

/** Input for `diskfile_create`. */
export const DiskfileCreateInput = object({
	path: DiskfilePath,
	content: string
});
export type DiskfileCreateInput = Infer<typeof DiskfileCreateInput>;

/** Input for `media_finalize`. */
export const MediaFinalizeInput = object({
	path: DiskfilePath
});
export type MediaFinalizeInput = Infer<typeof MediaFinalizeInput>;

/** Output for `media_finalize`: the rewritten file's size in bytes. */
export const MediaFinalizeOutput = object({
	size: number
});
export type MediaFinalizeOutput = Infer<typeof MediaFinalizeOutput>;

/** Input for `transcription_create`. */
export const TranscriptionCreateInput = object({
	path: DiskfilePath,
	/** A language code like `en`, or `auto` (the default) to detect it. */
	language: optional(string)
});
export type TranscriptionCreateInput = Infer<typeof TranscriptionCreateInput>;

/** Output for `transcription_create`: the job that will do it. */
export const TranscriptionCreateOutput = object({
	job_id: Uuid
});
export type TranscriptionCreateOutput = Infer<typeof TranscriptionCreateOutput>;

/** Input for the `transcription_progress` notification. */
export const TranscriptionProgressInput = object({
	job_id: Uuid,
	/** The segments decoded since the last notification. */
	segments: array(TranscriptSegment)
});
export type TranscriptionProgressInput = Infer<typeof TranscriptionProgressInput>;

/** Input for `job_cancel`. */
export const JobCancelInput = object({
	job_id: Uuid
});
export type JobCancelInput = Infer<typeof JobCancelInput>;

/** Input for the `job_changed` notification. */
export const JobChangedInput = object({
	job: JobSnapshot
});
export type JobChangedInput = Infer<typeof JobChangedInput>;

/** Input for `diskfile_delete`. */
export const DiskfileDeleteInput = object({
	path: DiskfilePath
});
export type DiskfileDeleteInput = Infer<typeof DiskfileDeleteInput>;

/** Input for `directory_create`. */
export const DirectoryCreateInput = object({
	path: DiskfilePath
});
export type DirectoryCreateInput = Infer<typeof DirectoryCreateInput>;

/** Input for `completion_create`. */
export const CompletionCreateInput = object({
	completion_request: CompletionRequest,
	_meta: optional(ProgressMeta)
});
export type CompletionCreateInput = Infer<typeof CompletionCreateInput>;

/** Output for `completion_create`. */
export const CompletionCreateOutput = object({
	completion_response: CompletionResponse,
	_meta: optional(ProgressMeta)
});
export type CompletionCreateOutput = Infer<typeof CompletionCreateOutput>;

/**
 * Input for `completion_progress`.
 *
 * TODO improve `chunk` schema. Today it carries a loose provider-shaped
 * payload (`model`, `created_at`, `done`, `message`); add `done_reason`,
 * timing fields (`total_duration`, `load_duration`, `prompt_eval_*`,
 * `eval_*`), `thinking`, `images`, `tool_calls` as more provider streams land.
 */
export const CompletionProgressInput = object({
	chunk: optional(
		loose_object({
			model: optional(string),
			created_at: optional(string),
			done: optional(boolean),
			message: optional(CompletionMessage)
		})
	),
	_meta: optional(ProgressMeta)
});
export type CompletionProgressInput = Infer<typeof CompletionProgressInput>;

// TODO this is just a placeholder for a local call
/** Input for `toggle_main_menu`. Optional — omit to toggle, pass `{show}` to set explicitly. */
export const ToggleMainMenuInput = optional(object({ show: optional(boolean) }));
export type ToggleMainMenuInput = Infer<typeof ToggleMainMenuInput>;

/** Output for `toggle_main_menu`. */
export const ToggleMainMenuOutput = object({ show: boolean });
export type ToggleMainMenuOutput = Infer<typeof ToggleMainMenuOutput>;

/** Input for `provider_load_status`. */
export const ProviderLoadStatusInput = object({
	provider_name: ProviderName,
	reload: with_default(boolean, true)
});
export type ProviderLoadStatusInput = Infer<typeof ProviderLoadStatusInput>;

/** Output for `provider_load_status`. */
export const ProviderLoadStatusOutput = object({
	status: ProviderStatus
});
export type ProviderLoadStatusOutput = Infer<typeof ProviderLoadStatusOutput>;

/** Input for `terminal_create`. */
export const TerminalCreateInput = object({
	command: string,
	args: with_default_fn(array(string), () => []),
	/** The working directory — absolute, never resolved against the daemon's own. */
	cwd: optional(pipe(string, message(check(is_path_absolute), 'cwd must be an absolute path'))),
	preset_id: optional(Uuid)
});
export type TerminalCreateInput = Infer<typeof TerminalCreateInput>;

/** Output for `terminal_create`. */
export const TerminalCreateOutput = object({
	terminal_id: Uuid
});
export type TerminalCreateOutput = Infer<typeof TerminalCreateOutput>;

/** Input for `terminal_data_send`. */
export const TerminalDataSendInput = object({
	terminal_id: Uuid,
	data: string
});
export type TerminalDataSendInput = Infer<typeof TerminalDataSendInput>;

/** Input for `terminal_data` (backend → frontend stdout/stderr stream). */
export const TerminalDataInput = object({
	terminal_id: Uuid,
	data: string,
	/**
	 * Bytes of output (`data` as UTF-8) the terminal has sent in total, this
	 * chunk included — the backend's count, echoed back by `terminal_ack`.
	 */
	sent_bytes: pipe(number, safe_integer, min_value(0))
});
export type TerminalDataInput = Infer<typeof TerminalDataInput>;

/** Input for `terminal_ack`. */
export const TerminalAckInput = object({
	terminal_id: Uuid,
	/**
	 * The `sent_bytes` of the last `terminal_data` the client finished with.
	 * Cumulative: the backend keeps the highest it has seen from a connection.
	 */
	bytes: pipe(number, safe_integer, min_value(0))
});
export type TerminalAckInput = Infer<typeof TerminalAckInput>;

/**
 * A terminal dimension (`cols` / `rows`) — the `u16` range of a PTY
 * `winsize`, minus zero.
 */
export const TerminalDimension = pipe(number, integer, min_value(1), max_value(65_535));
export type TerminalDimension = Infer<typeof TerminalDimension>;

/** Input for `terminal_resize`. */
export const TerminalResizeInput = object({
	terminal_id: Uuid,
	cols: TerminalDimension,
	rows: TerminalDimension
});
export type TerminalResizeInput = Infer<typeof TerminalResizeInput>;

/** A signal `terminal_close` can send. */
export const TerminalCloseSignal = one_of(['SIGTERM', 'SIGKILL']);
export type TerminalCloseSignal = Infer<typeof TerminalCloseSignal>;

/** Input for `terminal_close`. */
export const TerminalCloseInput = object({
	terminal_id: Uuid,
	signal: with_default(TerminalCloseSignal, 'SIGTERM')
});
export type TerminalCloseInput = Infer<typeof TerminalCloseInput>;

/** Output for `terminal_close`. */
export const TerminalCloseOutput = object({
	exit_code: nullable(number)
});
export type TerminalCloseOutput = Infer<typeof TerminalCloseOutput>;

/** Input for `terminal_exited`. */
export const TerminalExitedInput = object({
	terminal_id: Uuid,
	exit_code: nullable(number)
});
export type TerminalExitedInput = Infer<typeof TerminalExitedInput>;

/** Input for `project_open`: a file or directory, in the project to open. */
export const ProjectOpenInput = object({
	path: DiskfilePath
});
export type ProjectOpenInput = Infer<typeof ProjectOpenInput>;

/** Output for `project_open`. */
export const ProjectOpenOutput = object({
	project: ProjectInfoJson,
	/** The directory the open focused, or `null` — a registry's root, or a directory in no entry. */
	focus: nullable(DiskfileDirectoryPath),
	/** The index of every filer of the project: the root's and each focused directory's. */
	files: array(SerializableDisknode),
	watch_status: ProjectWatchStatus
});
export type ProjectOpenOutput = Infer<typeof ProjectOpenOutput>;

/** Input for `project_close`. */
export const ProjectCloseInput = object({
	root: DiskfileDirectoryPath
});
export type ProjectCloseInput = Infer<typeof ProjectCloseInput>;

/**
 * Input for `repo_focus`: a registry entry of an open project, by the
 * project's `root` and the entry's `dir` as the project reports them.
 */
export const RepoFocusInput = object({
	root: DiskfileDirectoryPath,
	dir: DiskfileDirectoryPath
});
export type RepoFocusInput = Infer<typeof RepoFocusInput>;

/** Output for `repo_focus`. */
export const RepoFocusOutput = object({
	project: ProjectInfoJson,
	/** The index of every filer of the project, the newly focused repo's included. */
	files: array(SerializableDisknode),
	watch_status: ProjectWatchStatus
});
export type RepoFocusOutput = Infer<typeof RepoFocusOutput>;

/** Input for `repo_unfocus`: a registry entry of an open project, as for `repo_focus`. */
export const RepoUnfocusInput = object({
	root: DiskfileDirectoryPath,
	dir: DiskfileDirectoryPath
});
export type RepoUnfocusInput = Infer<typeof RepoUnfocusInput>;

/** Output for `repo_unfocus`: the project as the unfocus left it. */
export const RepoUnfocusOutput = object({
	project: ProjectInfoJson
});
export type RepoUnfocusOutput = Infer<typeof RepoUnfocusOutput>;

/** Output for `project_list`. */
export const ProjectListOutput = object({
	projects: array(ProjectInfoJson)
});
export type ProjectListOutput = Infer<typeof ProjectListOutput>;

/**
 * Input for `project_changed`: a project newly `open`, `close`d, or an
 * `update` to an open one — a focus added or dropped, or its registry's
 * entries resolved again.
 */
export const ProjectChangedInput = object({
	type: one_of(['open', 'update', 'close']),
	project: ProjectInfoJson
});
export type ProjectChangedInput = Infer<typeof ProjectChangedInput>;

// -- Action specs -----------------------------------------------------------

export const ping_action_spec = {
	method: 'ping',
	kind: 'request_response',
	initiator: 'both',
	auth: { account: 'none', actor: 'none' },
	side_effects: false,
	input: fuz_void,
	output: PingOutput,
	async: true,
	description: 'Health check — echoes the request ID back to the caller.'
} satisfies RequestResponseActionSpec;

export const session_load_action_spec = {
	method: 'session_load',
	kind: 'request_response',
	// TODO @api is this actually a good restriction to have?
	// or should the server be calling actions internally too?
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: fuz_void,
	output: SessionLoadOutput,
	async: true,
	description:
		'Load the session snapshot (files, projects, terminals, jobs, provider status) — at boot and after each reconnect, to resync.'
} satisfies RequestResponseActionSpec;

export const filer_change_action_spec = {
	method: 'filer_change',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: FilerChangeInput,
	output: fuz_void,
	async: true,
	description:
		"Notifies the frontend of a file system change detected by the watcher. Carries the file's metadata, not its contents — a client holding them reads them again (`diskfile_read`)."
} satisfies RemoteNotificationActionSpec;

export const diskfile_read_action_spec = {
	method: 'diskfile_read',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: DiskfileReadInput,
	output: DiskfileReadOutput,
	async: true,
	description:
		"Read a file's contents as text, with their `hash`, its size, and timestamps. Any regular file in scope, except in a credential directory or a `.zzz` directory other than the app dir (`forbidden` / `protected_dir_not_allowed`); one over the size limit or not UTF-8 has `contents: null` and an `unloaded_reason`."
} satisfies RequestResponseActionSpec;

export const diskfile_update_action_spec = {
	method: 'diskfile_update',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: DiskfileUpdateInput,
	output: DiskfileUpdateOutput,
	async: true,
	description:
		"Write new content to a file on disk, returning the written bytes' `hash`. With `expected_hash` (a `diskfile_read` `hash`), only if the file still holds those bytes — else `conflict` (`disk_changed`), nothing written."
} satisfies RequestResponseActionSpec;

export const diskfile_create_action_spec = {
	method: 'diskfile_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: DiskfileCreateInput,
	output: literal(null),
	async: true,
	description:
		'Create a new file on disk, failing with `conflict` (`already_exists`) if the path is taken — never overwrites.'
} satisfies RequestResponseActionSpec;

export const diskfile_delete_action_spec = {
	method: 'diskfile_delete',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: DiskfileDeleteInput,
	output: literal(null),
	async: true,
	description: 'Delete a file from disk.'
} satisfies RequestResponseActionSpec;

export const directory_create_action_spec = {
	method: 'directory_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: DirectoryCreateInput,
	output: literal(null),
	async: true,
	description:
		'Create a new directory on disk, and any missing parents, failing with `conflict` (`already_exists`) if the path is taken — never reuses an existing one.'
} satisfies RequestResponseActionSpec;

export const media_finalize_action_spec = {
	method: 'media_finalize',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: MediaFinalizeInput,
	output: MediaFinalizeOutput,
	async: true,
	description:
		'Rewrite a recorded media file in place so its header has a duration and a seek index (an `ffmpeg` stream copy, nothing re-encoded). The container comes from the extension: WebM, Matroska, Ogg, MP4, MP3, WAV, FLAC, or AAC.'
} satisfies RequestResponseActionSpec;

export const transcription_create_action_spec = {
	method: 'transcription_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: TranscriptionCreateInput,
	output: TranscriptionCreateOutput,
	async: true,
	description:
		"Queue a transcription of an audio file by the local speech model, and return its job. The transcript is written beside the file as `<name>.<model>.transcript.json`; fails with `conflict` (`already_exists`) if that model's transcript is already there."
} satisfies RequestResponseActionSpec;

export const transcription_progress_action_spec = {
	method: 'transcription_progress',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: TranscriptionProgressInput,
	output: fuz_void,
	async: true,
	description:
		'Segments a running transcription just decoded — a preview; the transcript file is written when the job succeeds.'
} satisfies RemoteNotificationActionSpec;

export const job_cancel_action_spec = {
	method: 'job_cancel',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: JobCancelInput,
	output: literal(null),
	async: true,
	description:
		'Cancel a job: a queued one never starts, the running one is stopped. A job that is already over is left as it is.'
} satisfies RequestResponseActionSpec;

export const job_changed_action_spec = {
	method: 'job_changed',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: JobChangedInput,
	output: fuz_void,
	async: true,
	description: 'A job was queued, started, progressed, or finished — its full current state.'
} satisfies RemoteNotificationActionSpec;

export const completion_create_action_spec = {
	method: 'completion_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: CompletionCreateInput,
	output: CompletionCreateOutput,
	async: true,
	streams: 'completion_progress',
	description: 'Start an AI completion request, optionally with a progress token for streaming.'
} satisfies RequestResponseActionSpec;

export const completion_progress_action_spec = {
	method: 'completion_progress',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: CompletionProgressInput,
	output: fuz_void,
	async: true,
	description: 'Streams a completion chunk to the frontend during a streaming AI response.'
} satisfies RemoteNotificationActionSpec;

export const toggle_main_menu_action_spec = {
	method: 'toggle_main_menu',
	kind: 'local_call',
	initiator: 'frontend',
	auth: null,
	side_effects: true,
	input: ToggleMainMenuInput,
	output: ToggleMainMenuOutput,
	async: false,
	description: 'Toggle or set the visibility of the main navigation menu.'
} satisfies LocalCallActionSpec;

export const provider_load_status_action_spec = {
	method: 'provider_load_status',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: ProviderLoadStatusInput,
	output: ProviderLoadStatusOutput,
	async: true,
	description: 'Check the availability and status of an AI provider.'
} satisfies RequestResponseActionSpec;

export const terminal_create_action_spec = {
	method: 'terminal_create',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: TerminalCreateInput,
	output: TerminalCreateOutput,
	async: true,
	error_reasons: [ERROR_INVALID_PATH, ERROR_TERMINAL_COMMAND_NOT_FOUND],
	description:
		'Spawn a PTY process and return the terminal ID. A `cwd` must be absolute (`invalid_params` otherwise); a `command` that does not exist is `invalid_params` with `terminal_command_not_found`.'
} satisfies RequestResponseActionSpec;

export const terminal_data_send_action_spec = {
	method: 'terminal_data_send',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: TerminalDataSendInput,
	output: literal(null),
	async: true,
	description:
		'Send stdin bytes to a terminal. Fails with `not_found` when the caller has no live terminal with the id.'
} satisfies RequestResponseActionSpec;

export const terminal_data_action_spec = {
	method: 'terminal_data',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: TerminalDataInput,
	output: fuz_void,
	async: true,
	description: 'Stream stdout/stderr bytes from a terminal to the frontend.'
} satisfies RemoteNotificationActionSpec;

export const terminal_ack_action_spec = {
	method: 'terminal_ack',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: TerminalAckInput,
	output: literal(null),
	async: true,
	description:
		"Acknowledge a terminal's output up to a `terminal_data`'s `sent_bytes`. The backend stops reading a terminal whose output runs too far ahead of what an acknowledging WebSocket connection has taken, and resumes as acks arrive; connections that never acknowledge aren't waited for, and over HTTP the call does nothing. Fails with `not_found` when the caller has no live terminal with the id."
} satisfies RequestResponseActionSpec;

export const terminal_resize_action_spec = {
	method: 'terminal_resize',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: TerminalResizeInput,
	output: literal(null),
	async: true,
	description:
		'Update PTY dimensions for a terminal. Fails with `not_found` when the caller has no live terminal with the id.'
} satisfies RequestResponseActionSpec;

export const terminal_close_action_spec = {
	method: 'terminal_close',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: TerminalCloseInput,
	output: TerminalCloseOutput,
	async: true,
	description:
		'Kill a terminal process and return the exit code. Fails with `not_found` when the caller has no live terminal with the id.'
} satisfies RequestResponseActionSpec;

export const terminal_exited_action_spec = {
	method: 'terminal_exited',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: TerminalExitedInput,
	output: fuz_void,
	async: true,
	description: 'Notify the frontend that a terminal process exited naturally.'
} satisfies RemoteNotificationActionSpec;

export const project_open_action_spec = {
	method: 'project_open',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: ProjectOpenInput,
	output: ProjectOpenOutput,
	async: true,
	description:
		"Open the project holding a file or directory — a trusted `repos.toml`'s root found above it, else its git checkout, else the directory — adding the root to ScopedFs and focusing the repo holding the path, whose files are then indexed and watched (a registry's root alone is indexed at its top level). The root must be strictly inside the daemon's home directory or named by `ZZZ_ROOTS_OUTSIDE_HOME`, and never `/`, the home directory or an ancestor of it, a pseudo-filesystem, or a protected directory (`forbidden` / `root_not_allowed`, `root_outside_home`, `protected_dir_not_allowed`); an untrusted or unconfined registry refuses the open (`forbidden` / `registry_untrusted`, `registry_not_confined`), as does one that can't be read or doesn't parse (`invalid_params` / `registry_unreadable`, `registry_invalid`) or was replaced while it was checked (`conflict` / `registry_changed`, opening again reads the new one), or a walk that can't be bounded (`internal_error` / `bound_unusable`); a registry entry that escapes the root is refused alone, its reason on the entry."
} satisfies RequestResponseActionSpec;

export const project_close_action_spec = {
	method: 'project_close',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: ProjectCloseInput,
	output: literal(null),
	async: true,
	description:
		'Close a project — stops the file watching no other open project keeps and removes its root from ScopedFs.'
} satisfies RequestResponseActionSpec;

export const project_list_action_spec = {
	method: 'project_list',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: false,
	input: fuz_void,
	output: ProjectListOutput,
	async: true,
	description: 'List all open projects.'
} satisfies RequestResponseActionSpec;

export const repo_focus_action_spec = {
	method: 'repo_focus',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: RepoFocusInput,
	output: RepoFocusOutput,
	async: true,
	description:
		"Focus a registry entry of an open project — its files are then indexed and watched, as opening a path in it would, without resolving the registry again — and notify `project_changed` `update`; idempotent. Refuses a root that isn't open (`invalid_params` / `project_not_open`), a project that isn't a registry (`project_not_registry`), a directory that's none of its entries (`repo_not_in_project`), and an entry not yet cloned or gone since (`not_found`), or refused (`forbidden`), as last resolved (`repo_not_present` — opening the project again resolves it); a repo that can't be listed otherwise fails as `project_open`'s focused directory does (`forbidden` / `permission_denied`), leaving the project as it was."
} satisfies RequestResponseActionSpec;

export const repo_unfocus_action_spec = {
	method: 'repo_unfocus',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' },
	side_effects: true,
	input: RepoUnfocusInput,
	output: RepoUnfocusOutput,
	async: true,
	description:
		"Drop a registry entry from an open project's focus — its file watching stops unless another open project keeps it, and its files leave the index — and notify `project_changed` `update`; idempotent, and a registry may keep no focus. Refuses a root that isn't open (`invalid_params` / `project_not_open`), a project that isn't a registry, whose root stays focused while it's open (`project_not_registry`), and a directory that's none of its entries (`repo_not_in_project`)."
} satisfies RequestResponseActionSpec;

export const project_changed_action_spec = {
	method: 'project_changed',
	kind: 'remote_notification',
	initiator: 'backend',
	auth: null,
	side_effects: true,
	input: ProjectChangedInput,
	output: fuz_void,
	async: true,
	description:
		'Notifies frontends when a project is opened, changed (a focus added or dropped, its registry resolved again), or closed.'
} satisfies RemoteNotificationActionSpec;

/**
 * Canonical action spec list — fuz_app's protocol actions (`heartbeat`,
 * `cancel`) plus zzz-owned specs. Single source of truth for codegen and
 * runtime registries (`Frontend.action_registry`, `Backend.action_registry`).
 *
 * Codegen helpers default-filter protocol actions out of typed surfaces
 * (`FrontendActionsApi`, `BackendActionHandlers`, `ActionMethod`, etc.) since
 * they're dispatcher-owned. Server WS registration pairs protocol specs with
 * fuz_app-shipped handlers via `protocol_actions`; iteration over
 * `all_action_specs` skips them via `is_protocol_action_method` to avoid
 * double-registration. Adding a future protocol action requires no consumer
 * edit — fuz_app's `protocol_action_specs` is the upstream canonical bundle.
 */
export const all_action_specs: Array<ActionSpecUnion> = [
	...protocol_action_specs,
	ping_action_spec,
	session_load_action_spec,
	filer_change_action_spec,
	diskfile_read_action_spec,
	diskfile_update_action_spec,
	diskfile_create_action_spec,
	diskfile_delete_action_spec,
	directory_create_action_spec,
	media_finalize_action_spec,
	transcription_create_action_spec,
	transcription_progress_action_spec,
	job_cancel_action_spec,
	job_changed_action_spec,
	completion_create_action_spec,
	completion_progress_action_spec,
	toggle_main_menu_action_spec,
	provider_load_status_action_spec,
	terminal_create_action_spec,
	terminal_data_send_action_spec,
	terminal_data_action_spec,
	terminal_ack_action_spec,
	terminal_resize_action_spec,
	terminal_close_action_spec,
	terminal_exited_action_spec,
	project_open_action_spec,
	project_close_action_spec,
	project_list_action_spec,
	repo_focus_action_spec,
	repo_unfocus_action_spec,
	project_changed_action_spec
];
