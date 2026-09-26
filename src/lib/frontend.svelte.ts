import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';
import { z } from 'zod';
import { EMPTY_OBJECT } from '@fuzdev/fuz_util/object.ts';
import type { AsyncStatus } from '@fuzdev/fuz_util/async.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { Assignable, ClassConstructor, OmitStrict } from '@fuzdev/fuz_util/types.ts';
import type { Uuid } from '@fuzdev/fuz_util/id.ts';
import { ActionRegistry } from '@fuzdev/fuz_app/actions/action_registry.ts';
import { ActionEventPhase, type ActionSpecUnion } from '@fuzdev/fuz_app/actions/action_spec.ts';

import { Provider, type ProviderJsonInput } from './provider.svelte.ts';
import type { ProviderStatus } from './provider_types.ts';
import { Models } from './models.svelte.ts';
import { Chats } from './chats.svelte.ts';
import { Threads } from './threads.svelte.ts';
import { Providers } from './providers.svelte.ts';
import { Diskfiles } from './diskfiles.svelte.ts';
import { Actions } from './actions.svelte.ts';
import { Action } from './action.svelte.ts';
import type { ModelJsonInput } from './model.svelte.ts';
import { CellRegistry } from './cell_registry.svelte.ts';
import { Prompts } from './prompts.svelte.ts';
import { Parts } from './parts.svelte.ts';
import { Time } from './time.svelte.ts';
import { Spaces } from './spaces.svelte.ts';
import { Workspaces } from './workspaces.svelte.ts';
import type { Workspace } from './workspace.svelte.ts';
import { Terminals } from './terminals.svelte.ts';
import { ERROR_WORKSPACE_NOT_OPEN } from './workspace_helpers.ts';
import { TerminalPresets } from './terminal_presets.svelte.ts';
import {
	TERMINAL_LOST_TO_RESTART_MESSAGE,
	TERMINAL_LOST_WHILE_DISCONNECTED_MESSAGE
} from './terminal_helpers.ts';
import type { ZzzOptions } from './config_helpers.ts';
import { BOTS_DEFAULT } from './config_defaults.ts';
import { DiskfileDirectoryPath } from './diskfile_types.ts';
import { cell_classes } from './cell_classes.ts';
import { CellJson } from './cell_types.ts';
import { Ui, UiJson } from './ui.svelte.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { Socket } from './socket.svelte.ts';
import { Capabilities } from './capabilities.svelte.ts';
import { HANDLED } from './cell_helpers.ts';
import { ActionDispatcher } from '@fuzdev/fuz_app/actions/action_dispatcher.ts';
import {
	ActionExecutor,
	type ActionEventEnvironment
} from '@fuzdev/fuz_app/actions/action_event_types.ts';
import { FrontendHttpTransport } from '@fuzdev/fuz_app/actions/transports_http.ts';
import { FrontendWebsocketTransport } from '@fuzdev/fuz_app/actions/transports_ws.ts';
import { create_rpc_client } from '@fuzdev/fuz_app/actions/rpc_client.ts';
import { JSONRPC_ERROR_CODES } from '@fuzdev/fuz_app/http/jsonrpc_errors.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { FrontendActionsApi } from './action_metatypes.ts';
import type { FrontendActionHandlers } from './frontend_action_types.ts';
import { ActionOutputs } from './action_collections.ts';
import { all_action_specs } from './action_specs.ts';
import { create_frontend_action_handlers } from './frontend_action_handlers.ts';
import { create_detached } from './reactive_helpers.svelte.ts';

// TODO this is over-used, see also `app_context` for the user pattern
export const frontend_context = create_context<Frontend>();

/**
 * The `workspace_open` errors that mean a lost workspace can't be reopened —
 * its directory is gone, forbidden, or not a directory.
 */
const WORKSPACE_REOPEN_REFUSAL_CODES: ReadonlySet<number> = new Set([
	JSONRPC_ERROR_CODES.not_found,
	JSONRPC_ERROR_CODES.forbidden,
	JSONRPC_ERROR_CODES.invalid_params
]);

/** What changed while a session snapshot was in flight — see `Frontend.receive_session`. */
export interface SessionSnapshotChanges {
	/** Diskfile paths a `filer_change` touched (`Diskfiles.track_changes`). */
	file_paths: ReadonlySet<string>;
	/** Workspace paths opened or closed (`Workspaces.track_changes`). */
	workspace_paths: ReadonlySet<string>;
	/** Backend ids of the terminals running when the snapshot was requested. */
	running_terminal_ids: ReadonlySet<Uuid>;
}

/**
 * How long `Frontend.boot_session` waits for the socket to open before loading
 * the session over HTTP instead.
 */
export const SESSION_BOOT_FALLBACK_DELAY = 2_000;

/** Delay before the first `session_load` retry, doubling per failure. */
export const SESSION_LOAD_RETRY_DELAY = 1_000;
/** Cap on the `session_load` retry delay. */
export const SESSION_LOAD_RETRY_DELAY_MAX = 30_000;

export const FrontendJson = CellJson.extend({
	ui: UiJson.default(() => UiJson.parse({}))
	// TODO other state?
}).meta({ cell_class_name: 'Frontend' });
export type FrontendJson = z.infer<typeof FrontendJson>;
export type FrontendJsonInput = z.input<typeof FrontendJson>;

export interface FrontendOptions extends OmitStrict<CellOptions<typeof FrontendJson>, 'app'> {
	/** Do not use - optional to avoid circular reference problem. */
	app?: never;
	models?: Array<ModelJsonInput>;
	bots?: ZzzOptions['bots'];
	providers?: Array<ProviderJsonInput>;
	/** Cell classes to register, keyed by their `cell_class_name` (default `cell_classes`). */
	cell_classes?: Record<string, ClassConstructor<Cell<any>>>;
	action_specs?: Array<ActionSpecUnion>;
	action_handlers?: FrontendActionHandlers;

	http_rpc_url?: string | null;
	http_headers?: Record<string, string>;

	socket_url?: string | null;

	/**
	 * Called when an action fails with `unauthenticated` — the backend no longer
	 * accepts this session (revoked, expired, logged out elsewhere). Typically
	 * wired to a session recheck (see `create_session_recheck`).
	 */
	on_unauthenticated?: (() => void) | null;
}

/**
 * The base frontend app, typically used by creating your own `App extends Frontend`.
 * Gettable with `frontend_context.get()` inside a `FrontendRoot`.
 */
export class Frontend extends Cell<typeof FrontendJson> implements ActionEventEnvironment {
	readonly executor: ActionExecutor = 'frontend';
	// TODO give this a `log` (fuz_util `Logger`) once `log.ts` loads in the browser —
	// today it imports `node:util` and reads `process` at module load. Until then
	// fuz_app's dispatcher falls back to console for warnings and errors.

	/**
	 * App-wide cell registry, maps class names to constructor and tracks registered instances.
	 */
	readonly cell_registry: CellRegistry;

	readonly action_registry: ActionRegistry;
	readonly action_handlers: FrontendActionHandlers;
	readonly api: FrontendActionsApi;
	readonly peer: ActionDispatcher;

	// Cells - these are managed objects/collections that contain the app state
	readonly time: Time;
	readonly ui: Ui;
	readonly models: Models;
	readonly chats: Chats;
	readonly threads: Threads;
	readonly providers: Providers;
	readonly prompts: Prompts;
	readonly parts: Parts;
	readonly diskfiles: Diskfiles;
	readonly actions: Actions;
	readonly socket: Socket;
	readonly capabilities: Capabilities;
	readonly spaces: Spaces;
	readonly workspaces: Workspaces;
	readonly terminals: Terminals;
	readonly terminal_presets: TerminalPresets;

	readonly bots: ZzzOptions['bots'];

	// TODO maybe instead of this pattern with getters/setters, using an encoder?
	#zzz_dir: DiskfileDirectoryPath | null | undefined = $state.raw(null); // TODO should this be undefined?

	/**
	 * The `zzz_dir` is the path to Zzz's primary directory on the server's filesystem.
	 * The server's `ScopedFs` instance restricts operations to this directory.
	 * The value is `undefined` when uninitialized,
	 * `null` when loading, and `''` when disabled or no server.
	 */
	get zzz_dir(): DiskfileDirectoryPath | null | undefined {
		return this.#zzz_dir;
	}
	set zzz_dir(value: string | null | undefined) {
		const parsed = value == null ? value : DiskfileDirectoryPath.safeParse(value);
		this.#zzz_dir = parsed == null ? parsed : parsed.data;
	}

	#scoped_dirs: ReadonlyArray<DiskfileDirectoryPath> = $state.raw([]);

	/**
	 * Additional filesystem paths the server can access for user files.
	 */
	get scoped_dirs(): ReadonlyArray<DiskfileDirectoryPath> {
		return this.#scoped_dirs;
	}
	set scoped_dirs(value: ReadonlyArray<string>) {
		this.#scoped_dirs = value.map((p) => DiskfileDirectoryPath.parse(p));
	}

	/**
	 * Tracks which providers are available (configured with API keys).
	 */
	provider_status: Array<ProviderStatus> = $state([]);

	// TODO refactor
	readonly tags: Set<string> = $derived.by(() => {
		const tag_set: Set<string> = new Set();
		for (const model of this.models.items.by_id.values()) {
			for (const tag of model.tags) {
				tag_set.add(tag);
			}
		}
		return tag_set;
	});

	/** See into Zzz's future. */
	futuremode = $state.raw(false);

	/**
	 * Status of loading the session snapshot with `load_session` — `'failure'`
	 * while waiting to retry.
	 */
	session_status: AsyncStatus = $state.raw('initial');

	/** Why the last `session_load` failed, cleared when one succeeds. */
	session_error: string | null = $state.raw(null);

	/**
	 * The backend instance the last session snapshot came from — a snapshot
	 * with a different one means zzzd restarted. `null` until one loads.
	 */
	server_instance_id: Uuid | null = $state.raw(null);

	#session_retry_timeout: ReturnType<typeof setTimeout> | null = null;
	#session_retry_count = 0;
	/** A reconnect asked for a resync while a `session_load` was in flight. */
	#session_resync_queued = false;
	/**
	 * Whether the latest `session_load` attempt was sent while the socket was
	 * connected, `null` before the first — see `handle_socket_connect`.
	 */
	#session_load_over_socket: boolean | null = null;
	#session_boot_timeout: ReturnType<typeof setTimeout> | null = null;
	/** The socket's `last_connect_time` last seen by `handle_socket_connect`. */
	#socket_connect_time: number | null = null;
	/**
	 * Workspaces a restarted backend lost, to reopen — kept until a reopen
	 * succeeds or definitively fails (see `receive_session`).
	 */
	readonly #workspaces_to_reopen: Set<DiskfileDirectoryPath> = new Set();
	/** Workspaces with a reopen in flight. */
	readonly #workspaces_reopening: Set<DiskfileDirectoryPath> = new Set();
	/**
	 * Workspaces closed while their reopen was in flight — the backend's open
	 * scans before registering, so a close meanwhile finds nothing to close and
	 * the open lands anyway; the reopen closes it again when it succeeds.
	 */
	readonly #workspaces_reopen_cancelled: Set<DiskfileDirectoryPath> = new Set();
	#disposed = false;

	readonly #on_unauthenticated: (() => void) | null;

	constructor(options: FrontendOptions = EMPTY_OBJECT) {
		// Pass this instance as its own zzz reference - casting hacks around the circular reference
		super(FrontendJson, options as FrontendOptions & { app: Frontend });

		// Set the circular reference now that the object is constructed
		(this as Assignable<typeof this, 'app'>).app = this;

		this.cell_registry = new CellRegistry(this);

		this.action_registry = new ActionRegistry(options.action_specs ?? all_action_specs);
		this.action_handlers = options.action_handlers || create_frontend_action_handlers(this);

		// Register cell classes if provided, otherwise use the default
		const cells_to_register = options.cell_classes || cell_classes;
		for (const [class_name, constructor] of Object.entries(cells_to_register)) {
			this.cell_registry.register(class_name, constructor);
		}

		// Initialize cell collections - the frontend is the root cell
		this.time = new Time({ app: this });
		this.ui = new Ui({ app: this });
		this.models = new Models({ app: this });
		this.chats = new Chats({ app: this });
		this.threads = new Threads({ app: this });
		this.providers = new Providers({ app: this });
		this.prompts = new Prompts({ app: this });
		this.parts = new Parts({ app: this });
		this.diskfiles = new Diskfiles({ app: this });
		this.actions = new Actions({ app: this });
		this.socket = new Socket({ app: this });
		this.capabilities = new Capabilities({ app: this });
		this.spaces = new Spaces({ app: this });
		this.workspaces = new Workspaces({ app: this });
		this.terminals = new Terminals({ app: this });
		this.terminal_presets = new TerminalPresets({ app: this });

		this.bots = options.bots ?? BOTS_DEFAULT;
		this.#on_unauthenticated = options.on_unauthenticated ?? null;

		this.peer = new ActionDispatcher({ environment: this });

		this.api = create_rpc_client<FrontendActionsApi>({
			peer: this.peer,
			environment: this,
			on_action_event: (event) => {
				// `app.api` calls can come from component init, `onMount`, or an `$effect`,
				// and the action outlives them (see `create_detached`)
				const action = create_detached(
					() =>
						new Action({
							app: this,
							json: { method: event.spec.method, action_event_data: event.toJSON() }
						})
				);
				// listen before adding, so an action trimmed right away stops listening when disposed
				action.listen_to_action_event(event);
				this.actions.add(action);
				if (this.#on_unauthenticated) {
					event.observe((data, old_data) => {
						if (
							data.error !== old_data.error &&
							data.error?.code === JSONRPC_ERROR_CODES.unauthenticated
						) {
							this.#on_unauthenticated?.();
						}
					});
				}
			}
		});

		// Set up transports, adding websocket first so it'll be the default
		if (options.socket_url) {
			this.socket.connect(options.socket_url);
			this.peer.transports.register_transport(
				new FrontendWebsocketTransport(this.socket, (data) => this.peer.receive(data))
			);
		}
		if (options.http_rpc_url) {
			this.peer.transports.register_transport(
				new FrontendHttpTransport(
					options.http_rpc_url,
					options.http_headers,
					(method) => this.action_registry.spec_by_method.get(method)?.side_effects ?? true
				)
			);
		}

		this.decoders = {
			// TODO do this automatically from the schema?
			ui: (value) => {
				if (value && typeof value === 'object') {
					this.ui.set_json(value);
				}
				return HANDLED;
			}
		};

		if (options.providers?.length) {
			this.add_providers(options.providers);
		}

		if (options.models?.length) {
			this.models.add_many(options.models);
		}

		this.init();
	}

	// TODO think about what the scope of the frontend object's API should be, keep it more minimal than these methods

	/**
	 * Loads the session snapshot (`session_load`) and reconciles the app with it
	 * (see `receive_session`), retrying with backoff (`SESSION_LOAD_RETRY_DELAY`
	 * doubling to `SESSION_LOAD_RETRY_DELAY_MAX`) until one succeeds or the app
	 * is disposed. Calling it while a retry waits retries now. Runs at boot and
	 * after every reconnect (see `handle_socket_connect`).
	 *
	 * Changes that arrive while the request is in flight win over the snapshot,
	 * since they're at least as new: file paths a `filer_change` touched and
	 * workspaces opened or closed are left as they are, and only terminals
	 * running when the request was sent can be found lost.
	 *
	 * @returns whether this attempt succeeded
	 */
	async load_session(): Promise<boolean> {
		if (this.#disposed || this.session_status === 'pending') return false;
		this.#clear_session_retry();
		this.#clear_session_boot();
		this.session_status = 'pending';
		this.#session_load_over_socket = this.socket.connected;

		let error_message: string;
		const file_changes = this.diskfiles.track_changes();
		const workspace_changes = this.workspaces.track_changes();
		const running_terminal_ids = this.terminals.running_terminal_ids();
		const stop_tracking = (): void => {
			file_changes.stop();
			workspace_changes.stop();
		};
		try {
			const result = await this.api.session_load();
			stop_tracking();
			if (this.#disposed) return false;
			if (result.ok) {
				this.receive_session(result.value.data, {
					file_paths: file_changes.paths,
					workspace_paths: workspace_changes.paths,
					running_terminal_ids
				});
				this.session_status = 'success';
				this.session_error = null;
				this.#session_retry_count = 0;
				if (this.#session_resync_queued) {
					// a reconnect during the request — the snapshot may predate it
					this.#session_resync_queued = false;
					void this.load_session();
				}
				return true;
			}
			error_message = result.error.message;
		} catch (error) {
			// a throw sending the request or applying the snapshot is retried like a failed load
			stop_tracking();
			if (this.#disposed) return false;
			console.error('[frontend] session load failed:', error);
			error_message = to_error_message(error);
		}

		// the retry loads a fresh snapshot, which covers a queued resync
		this.#session_resync_queued = false;
		this.session_status = 'failure';
		this.session_error = error_message;
		const delay = Math.min(
			SESSION_LOAD_RETRY_DELAY * 2 ** this.#session_retry_count,
			SESSION_LOAD_RETRY_DELAY_MAX
		);
		this.#session_retry_count++;
		this.#session_retry_timeout = setTimeout(() => {
			this.#session_retry_timeout = null;
			void this.load_session();
		}, delay);
		return false;
	}

	/**
	 * Starts the boot-time session load. It waits for the socket to open, so
	 * the snapshot comes over the socket that then carries the notifications,
	 * with no gap between the two (see `handle_socket_connect`); if the socket
	 * hasn't opened within `fallback_delay`, it loads over HTTP instead. Loads
	 * right away when the socket is already open or there's none configured.
	 *
	 * @param fallback_delay - ms to wait for the socket before loading over HTTP
	 */
	boot_session(fallback_delay: number = SESSION_BOOT_FALLBACK_DELAY): void {
		if (
			this.#disposed ||
			this.#session_load_over_socket !== null ||
			this.#session_boot_timeout !== null
		) {
			return;
		}
		if (this.socket.connected || !this.socket.url_input) {
			void this.load_session();
			return;
		}
		this.#session_boot_timeout = setTimeout(() => {
			this.#session_boot_timeout = null;
			void this.load_session();
		}, fallback_delay);
	}

	/**
	 * Handles the socket's `last_connect_time` changing — call it with each new
	 * value (the app root wires this to the socket's reactive state).
	 *
	 * Notifications only arrive while the socket is open, so a snapshot loaded
	 * before this connect may miss changes: those sent while a previous socket
	 * was down (`filer_change`, `workspace_changed`, `terminal_data`,
	 * `terminal_exited`), or, on the first connect, those between an HTTP
	 * boot load and the socket opening. So:
	 *
	 * - with no load yet, this is the boot load (see `boot_session`)
	 * - on the first connect, a load sent while the socket was already open
	 *   (so over it) needs nothing more
	 * - otherwise, an earlier load is followed by a resync — the
	 *   session snapshot is reloaded (after the in-flight load, if any) to
	 *   reconcile files, workspaces, and terminals, and on a reconnect running
	 *   terminals are flagged as possibly missing output
	 *
	 * @param connect_time - the socket's `last_connect_time`, `null` before it connects
	 * @returns whether this connect started a resync
	 */
	handle_socket_connect(connect_time: number | null): boolean {
		if (connect_time === null || connect_time === this.#socket_connect_time) return false;
		const first = this.#socket_connect_time === null;
		this.#socket_connect_time = connect_time;
		if (this.#disposed) return false;
		const over_socket = this.#session_load_over_socket;
		if (over_socket === null) {
			void this.load_session();
			return false;
		}
		// the latest load already went over this socket
		if (first && over_socket) return false;
		if (!first) this.terminals.mark_output_gap();
		if (this.session_status === 'pending') {
			this.#session_resync_queued = true;
		} else {
			void this.load_session();
		}
		return true;
	}

	#clear_session_boot(): void {
		if (this.#session_boot_timeout === null) return;
		clearTimeout(this.#session_boot_timeout);
		this.#session_boot_timeout = null;
	}

	#clear_session_retry(): void {
		if (this.#session_retry_timeout === null) return;
		clearTimeout(this.#session_retry_timeout);
		this.#session_retry_timeout = null;
	}

	// TODO refactor, probably `app.session`
	/**
	 * Reconciles the app with a session snapshot — replacing, not just adding:
	 *
	 * - workspaces: adds the listed ones and removes the rest
	 *   (`Workspaces.reconcile`) — except after a zzzd restart (a new
	 *   `server_instance_id`), when the ones it lost are reopened instead
	 *   (`Workspaces.open`), keeping their files and tabs; a reopen refused
	 *   because the directory is gone or forbidden drops the workspace and its
	 *   files, while any other failure keeps it for the next snapshot to retry
	 * - files: upserts the snapshot's, and removes known files it lacks under
	 *   `file_roots` or a removed workspace, keeping ones with unsaved edits
	 *   (`Diskfiles.reconcile`) — files elsewhere are left alone
	 * - terminals: running ones the backend no longer has become `lost`
	 *   (`Terminals.reconcile`)
	 *
	 * @param data - the `session_load` output's snapshot
	 * @param changes - what changed while the snapshot was in flight, which the
	 *   snapshot doesn't override (see `load_session`); without it nothing is
	 *   skipped and every running terminal is judged
	 */
	receive_session(
		data: ActionOutputs['session_load']['data'],
		changes?: SessionSnapshotChanges
	): void {
		const restarted =
			this.server_instance_id !== null && this.server_instance_id !== data.server_instance_id;
		this.server_instance_id = data.server_instance_id;
		this.zzz_dir = data.zzz_dir;
		this.scoped_dirs = data.scoped_dirs;
		this.provider_status = data.provider_status;

		// workspaces changed in flight or being reopened are left as they are
		const skip_workspaces: Set<string> = new Set(changes?.workspace_paths);
		for (const path of this.#workspaces_reopening) skip_workspaces.add(path);
		// lost to an earlier restart, their reopen failed without a refusal — retry
		const listed: Set<string> = new Set(data.workspaces.map((w) => w.path));
		const retry: Array<DiskfileDirectoryPath> = [];
		for (const path of this.#workspaces_to_reopen) {
			if (listed.has(path) || !this.workspaces.get_by_path(path)) {
				this.#workspaces_to_reopen.delete(path);
			} else if (!skip_workspaces.has(path)) {
				retry.push(path);
			}
		}
		const unlisted = this.workspaces.reconcile(data.workspaces, {
			skip_paths: new Set([...skip_workspaces, ...retry]),
			keep_unlisted: restarted
		});
		const reopen = restarted ? [...unlisted, ...retry] : retry;
		const removed = restarted ? [] : unlisted;

		// a removed workspace's files are gone from the backend's view unless
		// another root covers them — then they're in the snapshot or pruned there
		this.diskfiles.reconcile(data.files, [...data.file_roots, ...removed], {
			skip_paths: changes?.file_paths,
			skip_dirs: [...skip_workspaces, ...reopen]
		});

		this.terminals.reconcile(
			new Set(data.terminal_ids),
			changes?.running_terminal_ids ?? this.terminals.running_terminal_ids(),
			restarted ? TERMINAL_LOST_TO_RESTART_MESSAGE : TERMINAL_LOST_WHILE_DISCONNECTED_MESSAGE
		);

		for (const path of reopen) void this.#reopen_workspace(path, data.file_roots);
	}

	/**
	 * Closes the workspace at `path` (`workspace_close`) and removes it here. A
	 * reply that it isn't open (`ERROR_WORKSPACE_NOT_OPEN` — e.g. a restart
	 * forgot it and its reopen hasn't succeeded) removes it here too, and the
	 * close always cancels a pending reopen — one in flight closes the workspace
	 * again once it lands — so a closed workspace stays closed.
	 *
	 * @returns the RPC result — any failure but "not open" is for the caller to surface
	 */
	async close_workspace(
		path: DiskfileDirectoryPath
	): Promise<Result<{ value: null }, { error: JsonrpcErrorObject }>> {
		this.#workspaces_to_reopen.delete(path);
		if (this.#workspaces_reopening.has(path)) this.#workspaces_reopen_cancelled.add(path);
		const result = await this.api.workspace_close({ path });
		if (!result.ok) {
			const { reason } = (result.error.data ?? {}) as { reason?: unknown };
			if (reason !== ERROR_WORKSPACE_NOT_OPEN) return result;
		}
		this.workspaces.remove_by_path(path);
		return { ok: true, value: null };
	}

	/**
	 * Reopens a workspace a restarted backend lost, reconciling its files. A
	 * refusal saying the directory is gone or forbidden drops the workspace and
	 * the files only it covered; any other failure keeps it for the next session
	 * snapshot to retry, so nothing loops. A `close_workspace` while it's in
	 * flight wins: a reopen that lands anyway is closed again.
	 */
	async #reopen_workspace(
		path: DiskfileDirectoryPath,
		file_roots: ReadonlyArray<string>
	): Promise<void> {
		this.#workspaces_to_reopen.add(path);
		this.#workspaces_reopening.add(path);
		let opened: Workspace | null = null;
		let error: JsonrpcErrorObject | null = null;
		let cancelled = false;
		try {
			const result = await this.workspaces.open(path, { reconcile_files: true });
			if (result.ok) {
				opened = result.value;
			} else {
				error = result.error;
			}
		} catch (thrown) {
			error = { code: JSONRPC_ERROR_CODES.internal_error, message: to_error_message(thrown) };
		} finally {
			this.#workspaces_reopening.delete(path);
			cancelled = this.#workspaces_reopen_cancelled.delete(path);
		}
		if (opened) {
			this.#workspaces_to_reopen.delete(path);
			if (cancelled && !this.#disposed) {
				// closed while in flight, and the backend opened it anyway — close it again
				const closed = await this.close_workspace(opened.path);
				if (!closed.ok) {
					console.error(`[frontend] failed to close reopened workspace ${path}:`, closed.error);
				}
			}
			return;
		}
		if (!error) return;
		if (this.#disposed) return;
		console.error(`[frontend] failed to reopen workspace ${path} after zzzd restarted:`, error);
		if (!WORKSPACE_REOPEN_REFUSAL_CODES.has(error.code)) return;
		this.#workspaces_to_reopen.delete(path);
		this.workspaces.remove_by_path(path);
		this.diskfiles.reconcile([], [path], { skip_dirs: file_roots });
	}

	add_providers(providers_json: Array<ProviderJsonInput>): void {
		for (const json of providers_json) {
			this.add_provider(json);
		}
	}

	add_provider(provider_json: ProviderJsonInput): void {
		this.providers.add(new Provider({ app: this, json: provider_json }));
	}

	lookup_provider_status(provider_name: string): ProviderStatus | null {
		return this.provider_status.find((s) => s.name === provider_name) ?? null;
	}

	update_provider_status(status: ProviderStatus): void {
		const existing = this.lookup_provider_status(status.name);
		if (existing) {
			const index = this.provider_status.indexOf(existing);
			this.provider_status[index] = status;
		} else {
			this.provider_status.push(status);
		}
	}

	/**
	 * Tear the app down: closes the socket (no reconnect loop is left behind),
	 * stops `session_load` retries and the cells that own timers, then unregisters.
	 */
	override dispose(): void {
		this.#disposed = true;
		this.#clear_session_retry();
		this.#clear_session_boot();
		this.socket.disconnect();
		this.terminals.dispose();
		this.time.dispose();
		super.dispose();
	}

	lookup_action_handler(
		method: string,
		phase: ActionEventPhase
	): ((event: any) => any) | undefined {
		const method_handlers = (this.action_handlers as any)[method];
		if (!method_handlers) return undefined;
		return method_handlers[phase];
	}

	lookup_action_spec(method: string): ActionSpecUnion | undefined {
		return this.action_registry.spec_by_method.get(method);
	}
}
