import {
	parse,
	parse_or_throw,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';
import { EMPTY_OBJECT } from '@fuzdev/fuz_util/object.ts';
import type { AsyncStatus } from '@fuzdev/fuz_util/async.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { Assignable, ClassConstructor, OmitStrict } from '@fuzdev/fuz_util/types.ts';
import type { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { ActionRegistry } from '@fuzdev/fuz_app/actions/action_registry.ts';
import { ActionEventPhase, type ActionSpecUnion } from '@fuzdev/fuz_app/actions/action_spec.ts';

import { Provider, type ProviderJsonInput } from './provider.svelte.ts';
import type { ProviderStatus } from './provider_types.ts';
import { Models } from './models.svelte.ts';
import { Chats } from './chats.svelte.ts';
import { Threads } from './threads.svelte.ts';
import { Providers } from './providers.svelte.ts';
import { Diskfiles, type DiskfileSnapshotChanges } from './diskfiles.svelte.ts';
import { Actions } from './actions.svelte.ts';
import { Action } from './action.svelte.ts';
import type { ModelJsonInput } from './model.svelte.ts';
import { CellRegistry } from './cell_registry.svelte.ts';
import { Prompts } from './prompts.svelte.ts';
import { Parts } from './parts.svelte.ts';
import { Time } from './time.svelte.ts';
import { Projects } from './projects.svelte.ts';
import type { ProjectInfoJson } from './project.svelte.ts';
import { Terminals } from './terminals.svelte.ts';
import { Recorder } from './recorder.svelte.ts';
import { Jobs } from './jobs.svelte.ts';
import { ERROR_PROJECT_NOT_OPEN, ERROR_REPO_INDEX_FAILED } from './project_helpers.ts';
import { TerminalPresets } from './terminal_presets.svelte.ts';
import {
	TERMINAL_LOST_TO_RESTART_MESSAGE,
	TERMINAL_LOST_WHILE_DISCONNECTED_MESSAGE
} from './terminal_helpers.ts';
import type { ZzzOptions } from './config_helpers.ts';
import { BOTS_DEFAULT } from './config_defaults.ts';
import { DiskfileDirectoryPath } from './diskfile_types.ts';
import { decode_snapshot_files } from './diskfile_helpers.ts';
import { cell_classes } from './cell_classes.ts';
import { cell_json_schema } from './cell_types.ts';
import { Ui, UiJson } from './ui.svelte.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { Socket } from './socket.svelte.ts';
import { RPC_MESSAGE_MAX_BYTES } from './rpc_message_limit.ts';
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
// registers zzz's `ai_provider_error` (-32020 → 502) in fuz_app's status table
// before any transport reads it
import './zzz_jsonrpc_errors.ts';
import type { JsonrpcErrorObject } from '@fuzdev/fuz_app/http/jsonrpc.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';

import {
	create_untracked_intents,
	is_intent_action_spec,
	type FrontendIntentsApi,
	type FrontendRpcApi
} from './intent_spec.ts';
import { RecentIntents } from './recent_intents.svelte.ts';
import type { FrontendActionHandlers } from './frontend_action_types.ts';
import type { ActionOutputs } from './action_collections.ts';
import { all_action_specs } from './action_specs.ts';
import { create_frontend_action_handlers } from './frontend_action_handlers.ts';
import { create_detached } from './reactive_helpers.svelte.ts';
import {
	QUIET_ACTION_METHODS,
	bound_action_event_data,
	create_quiet_action_log
} from './action_helpers.ts';

// TODO this is over-used, see also `app_context` for the user pattern
export const frontend_context = create_context<Frontend>();

/**
 * The `project_open` errors that mean a lost project can't be reopened from
 * its root — it's gone or forbidden, or its registry can't be used.
 */
const PROJECT_REOPEN_REFUSAL_CODES: ReadonlySet<number> = new Set([
	JSONRPC_ERROR_CODES.not_found,
	JSONRPC_ERROR_CODES.forbidden,
	JSONRPC_ERROR_CODES.invalid_params
]);

/** What changed while a session snapshot was in flight — see `Frontend.receive_session`. */
export interface SessionSnapshotChanges {
	/** What `filer_change` reported (`Diskfiles.track_changes`). */
	file_changes: DiskfileSnapshotChanges;
	/**
	 * `Projects.received` when the snapshot was requested — a restart's
	 * snapshot can't be ordered against state received while it was in
	 * flight, applied or not.
	 */
	projects_received: number;
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

export const FrontendJson = cell_json_schema(
	{
		ui: with_default_fn(UiJson, () => parse_or_throw(UiJson, {}))
		// TODO other state?
	},
	'Frontend'
);
export type FrontendJson = Infer<typeof FrontendJson>;
export type FrontendJsonInput = InferInput<typeof FrontendJson>;

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
	/**
	 * The backend API's URL or path, with no trailing slash — what the byte
	 * routes hang off (see `file_bytes.ts`). Without it nothing can be recorded.
	 */
	api_url?: string | null;

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
	// TODO make this a fuz_util `Logger` once `log.ts` loads in the browser —
	// today it imports `node:util` and reads `process` at module load.
	/**
	 * Where fuz_app's dispatcher reports warnings and errors: the console,
	 * minus the failed sends of the quiet methods (`QUIET_ACTION_METHODS`).
	 * The dispatch path reads only the `ActionLog` surface of it.
	 */
	readonly log: Logger = create_quiet_action_log() as unknown as Logger;

	/**
	 * App-wide cell registry, maps class names to constructor and tracks registered instances.
	 */
	readonly cell_registry: CellRegistry;

	readonly action_registry: ActionRegistry;
	readonly action_handlers: FrontendActionHandlers;
	/** The RPC surface: every action but the intents. */
	readonly api: FrontendRpcApi;
	/**
	 * The UI intents (`IntentActionSpec`): every driver of a UI action — a
	 * click, a shortcut, the command palette, a test — calls these. Each call
	 * lands in `recent_intents`, not in the `actions` wire log.
	 */
	readonly intents: FrontendIntentsApi;
	readonly recent_intents: RecentIntents = new RecentIntents();
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
	readonly projects: Projects;
	readonly terminals: Terminals;
	readonly terminal_presets: TerminalPresets;
	readonly recorder: Recorder;
	readonly jobs: Jobs;

	/** The backend API's URL or path, with no trailing slash — `null` without one. */
	readonly api_url: string | null;

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
		const parsed = value == null ? value : parse(DiskfileDirectoryPath, value);
		this.#zzz_dir = parsed == null ? parsed : parsed.ok ? parsed.value : undefined;
	}

	/** The daemon's home directory, which `~` expands to; null when it has none. */
	home_dir: DiskfileDirectoryPath | null = $state.raw(null);

	#scoped_dirs: ReadonlyArray<DiskfileDirectoryPath> = $state.raw([]);

	/**
	 * Additional filesystem paths the server can access for user files.
	 */
	get scoped_dirs(): ReadonlyArray<DiskfileDirectoryPath> {
		return this.#scoped_dirs;
	}
	set scoped_dirs(value: ReadonlyArray<string>) {
		this.#scoped_dirs = value.map((p) => parse_or_throw(DiskfileDirectoryPath, p));
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
	/** A resync (see `resync_session`) was asked for while a `session_load` was in flight. */
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
	 * Projects a restarted backend lost, by root, with the focus still to
	 * restore (`Project.reopen_paths`, less what landed or was refused) — kept
	 * until each is reopened or definitively fails (see `receive_session`).
	 */
	readonly #projects_to_reopen: Map<DiskfileDirectoryPath, Array<DiskfileDirectoryPath>> =
		new Map();
	/** Roots of projects with a reopen in flight. */
	readonly #projects_reopening: Set<DiskfileDirectoryPath> = new Set();
	/**
	 * Roots of projects closed while their reopen was in flight — the
	 * backend's open scans before registering, so a close meanwhile finds
	 * nothing to close and the open lands anyway; the reopen closes it again
	 * when it succeeds.
	 */
	readonly #projects_reopen_cancelled: Set<DiskfileDirectoryPath> = new Set();
	/**
	 * Roots of projects whose reopen was in flight when zzzd restarted again —
	 * what it reopened was on the instance that's gone, so when it settles its
	 * whole focus is queued again (see `#reopen_project`).
	 */
	readonly #projects_restarted_while_reopening: Set<DiskfileDirectoryPath> = new Set();
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
		this.projects = new Projects({ app: this });
		this.terminals = new Terminals({ app: this });
		this.terminal_presets = new TerminalPresets({ app: this });
		this.api_url = options.api_url ?? null;
		this.recorder = new Recorder({ app: this });
		this.jobs = new Jobs({ app: this });

		this.bots = options.bots ?? BOTS_DEFAULT;
		this.#on_unauthenticated = options.on_unauthenticated ?? null;

		this.peer = new ActionDispatcher({ environment: this });

		this.api = create_rpc_client<FrontendRpcApi>({
			peer: this.peer,
			// the intents are `app.intents`' alone
			environment: {
				executor: this.executor,
				log: this.log,
				lookup_action_handler: (method, phase) => this.lookup_action_handler(method, phase),
				lookup_action_spec: (method) => {
					const spec = this.lookup_action_spec(method);
					return spec && is_intent_action_spec(spec) ? undefined : spec;
				}
			},
			on_action_event: (event) => {
				// flow-control calls would turn the whole history over in seconds
				if (!QUIET_ACTION_METHODS.has(event.spec.method)) {
					// `app.api` calls can come from component init, `onMount`, or an `$effect`,
					// and the action outlives them (see `create_detached`)
					const action = create_detached(
						() =>
							new Action({
								app: this,
								json: {
									method: event.spec.method,
									action_event_data: bound_action_event_data(event.data)
								}
							})
					);
					// listen before adding, so an action trimmed right away stops listening when disposed
					action.listen_to_action_event(event);
					this.actions.add(action);
				}
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

		this.intents = create_untracked_intents(
			create_rpc_client<FrontendIntentsApi>({
				peer: this.peer,
				environment: {
					executor: this.executor,
					log: this.log,
					lookup_action_handler: (method, phase) => this.lookup_action_handler(method, phase),
					lookup_action_spec: (method) => {
						const spec = this.lookup_action_spec(method);
						return spec && is_intent_action_spec(spec) ? spec : undefined;
					}
				},
				on_action_event: (event) => {
					const spec = event.spec;
					if (!is_intent_action_spec(spec)) return;
					// a sync intent is parsed and handled right after this returns
					const stop = event.observe((data, old_data) => {
						if (data.step === 'handled') {
							stop();
							this.recent_intents.record(spec, data.input, 'applied');
						} else if (data.step === 'failed') {
							stop();
							// input that failed its schema is whatever the caller passed (an
							// event, a cycle) — not kept, nor rendered
							const input = old_data.step === 'initial' ? null : data.input;
							this.recent_intents.record(spec, input, 'failed', data.error?.message ?? null);
						}
					});
				}
			})
		);

		// Set up transports, adding websocket first so it'll be the default
		if (options.socket_url) {
			this.socket.connect(options.socket_url);
			this.peer.transports.register_transport(
				// the backend's WS cap is raised to 16 MiB — refuse only what it would
				new FrontendWebsocketTransport(this.socket, (data) => this.peer.receive(data), {
					max_message_bytes: RPC_MESSAGE_MAX_BYTES
				})
			);
		}
		if (options.http_rpc_url) {
			this.peer.transports.register_transport(
				new FrontendHttpTransport({
					url: options.http_rpc_url,
					headers: options.http_headers,
					lookup_action_spec: (method) => this.lookup_action_spec(method)
				})
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
	 * Changes that arrive while the request is in flight win over the snapshot:
	 * files a `filer_change` reported (see `Diskfiles.track_changes`) are left
	 * as they are, project state is ordered by its rev (`Projects.reconcile`),
	 * and only terminals running when the request was sent can be found lost. The snapshot
	 * carries no contents: every file held eagerly is read again (the shown
	 * ones first), and any other loaded file drops its content
	 * (`Diskfiles.upsert`).
	 *
	 * A success also re-pings a backend whose last ping failed (see
	 * `Capabilities.check_backend`).
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
		const projects_received = this.projects.received;
		const running_terminal_ids = this.terminals.running_terminal_ids();
		const stop_tracking = (): void => {
			file_changes.stop();
		};
		try {
			const result = await this.api.session_load();
			stop_tracking();
			if (this.#disposed) return false;
			if (result.ok) {
				this.receive_session(result.value.data, {
					file_changes,
					projects_received,
					running_terminal_ids
				});
				this.session_status = 'success';
				this.session_error = null;
				this.#session_retry_count = 0;
				// the backend answered, so a failed ping (e.g. at mount, while the
				// daemon restarted) is stale — re-ping so the backend and filesystem
				// capabilities recover instead of reading unavailable for good
				if (this.capabilities.backend.status === 'failure') {
					void this.capabilities.check_backend();
				}
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
	 * was down (`filer_change`, `project_changed`, `terminal_data`,
	 * `terminal_exited`), or, on the first connect, those between an HTTP
	 * boot load and the socket opening. So:
	 *
	 * - on every connect, this tab's terminals hold their acks and announce
	 *   their position to the new connection with its first chunk
	 *   (`Terminals.receive_socket_connect`)
	 * - with no load yet, this is the boot load (see `boot_session`)
	 * - on the first connect, a load sent while the socket was already open
	 *   (so over it) needs nothing more
	 * - otherwise, an earlier load is followed by a resync — the
	 *   session snapshot is reloaded (after the in-flight load, if any) to
	 *   reconcile files, projects, and terminals, and on a reconnect running
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
		// a new connection, which the backend paces no terminal against yet
		this.terminals.receive_socket_connect();
		const over_socket = this.#session_load_over_socket;
		if (over_socket === null) {
			void this.load_session();
			return false;
		}
		// the latest load already went over this socket
		if (first && over_socket) return false;
		if (!first) this.terminals.mark_output_gap();
		this.resync_session();
		return true;
	}

	/**
	 * Reloads the session snapshot to reconcile state no notification
	 * carries — after a reconnect, a project opened elsewhere, or a remote
	 * change a pull can't settle (see `Projects.receive_remote_change`). With a
	 * load in flight, which may predate the change, another follows it.
	 */
	resync_session(): void {
		if (this.#disposed) return;
		if (this.session_status === 'pending') {
			this.#session_resync_queued = true;
		} else {
			void this.load_session();
		}
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
	 * - projects: applies the listed ones by their rev, and removes the held
	 *   ones it doesn't list that are no newer than its `projects_rev`
	 *   (`Projects.reconcile`) — except after a zzzd restart (a new
	 *   `server_instance_id`), which first forgets every rev held
	 *   (`Projects.reset_revs`: the new instance's snapshot is the truth),
	 *   and when the ones it lost are reopened instead
	 *   (one `Projects.open` of each root, requesting the directories it had
	 *   focused), keeping their files and tabs; a reopen refused because the
	 *   root is gone or forbidden, or that resolves to another project, drops
	 *   the project and its files, while any other failure keeps it for the
	 *   next snapshot to retry
	 * - files: upserts the snapshot's, and removes known files it lacks under
	 *   `file_roots` or a removed project, keeping ones with unsaved edits
	 *   (`Diskfiles.reconcile`) — files elsewhere, and under a project whose
	 *   state held is newer than the snapshot or that's being reopened, are
	 *   left alone; the snapshot's files under a root closed here since it
	 *   was read, or under a newer state held, are added only where the
	 *   index held covers them (`Diskfiles.is_indexed`)
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
		this.home_dir = data.home_dir;
		this.provider_status = data.provider_status;

		// what a restart's reopen restores is the focus held before the snapshot
		// applies — a project another client reopened first is listed with only
		// what it restored
		const lost_focus: Map<DiskfileDirectoryPath, ReadonlyArray<DiskfileDirectoryPath>> = new Map(
			restarted ? this.projects.items.values.map((p) => [p.root, p.reopen_paths]) : []
		);
		if (restarted) {
			// revs from the instance that's gone say nothing about the new one's
			// (a clock that stepped back seeds it lower), so the snapshot is the
			// truth — but state the new instance sent while it was in flight may
			// be newer than it, applied or dropped by the old revs, so load
			// another, which orders after both (and has the same instance id, so
			// it doesn't come back here)
			this.projects.reset_revs();
			if (changes && changes.projects_received !== this.projects.received) {
				this.resync_session();
			}
		}

		// projects being reopened are kept — a reopen this restart overtook
		// queues its whole focus once it settles
		const reopening: Set<DiskfileDirectoryPath> = new Set(this.#projects_reopening);
		if (restarted) {
			for (const root of reopening) this.#projects_restarted_while_reopening.add(root);
		}
		// lost to an earlier restart, some of their reopen failed without a
		// refusal — retry what the snapshot doesn't show reopened
		const listed: Map<string, ProjectInfoJson> = new Map(data.projects.map((p) => [p.root, p]));
		const retry: Array<DiskfileDirectoryPath> = [];
		for (const [root, paths] of this.#projects_to_reopen) {
			const info = listed.get(root);
			const pending = info
				? paths.filter((path) => path !== root && !info.focused.includes(path))
				: paths;
			if (!pending.length || !this.projects.get_by_root(root)) {
				this.#projects_to_reopen.delete(root);
				continue;
			}
			this.#projects_to_reopen.set(root, pending);
			if (!reopening.has(root)) retry.push(root);
		}
		const { unlisted, newer, refused } = this.projects.reconcile(data.projects, data.projects_rev, {
			keep_roots: new Set([...reopening, ...retry]),
			keep_unlisted: restarted
		});
		const reopen = restarted ? [...unlisted, ...retry] : retry;
		const removed = restarted ? [] : unlisted;

		// a listed root closed here since the snapshot was read, or held at a
		// newer state that may index less (an unfocus applied meanwhile): its
		// files the index no longer covers aren't added back
		const stale = [...refused, ...newer];
		const snapshot_files = decode_snapshot_files(data.files);
		const files = stale.length
			? snapshot_files.filter(
					(file) =>
						!stale.some((root) => file.id.startsWith(root)) || this.diskfiles.is_indexed(file.id)
				)
			: snapshot_files;
		// a removed project's files are gone from the backend's view unless
		// another root covers them — then they're in the snapshot or pruned there
		this.diskfiles.reconcile(files, [...data.file_roots, ...removed], {
			changes: changes?.file_changes,
			skip_dirs: [...newer, ...reopening, ...reopen]
		});

		this.terminals.reconcile(
			new Set(data.terminal_ids),
			changes?.running_terminal_ids ?? this.terminals.running_terminal_ids(),
			restarted ? TERMINAL_LOST_TO_RESTART_MESSAGE : TERMINAL_LOST_WHILE_DISCONNECTED_MESSAGE
		);

		// jobs live on the backend, so its list is the truth — a restart empties it
		this.jobs.reconcile(data.jobs);

		for (const root of new Set(reopen)) {
			const project = this.projects.get_by_root(root);
			if (!project) continue;
			const pending = this.#projects_to_reopen.get(root);
			// after a restart, the whole focus and any pending retry — less what the
			// backend has focused already, when another client reopened it first;
			// otherwise only what's pending
			const info = listed.get(root);
			const held = lost_focus.get(root) ?? project.reopen_paths;
			const paths = (
				restarted ? Array.from(new Set([...held, ...(pending ?? [])])) : (pending ?? held)
			).filter((path) => !info || (path !== root && !info.focused.includes(path)));
			if (!paths.length) {
				this.#projects_to_reopen.delete(root);
				continue;
			}
			void this.#reopen_project(root, paths);
		}
	}

	/**
	 * Closes the project at `root` (`project_close`) and applies the close at
	 * its rev (`Projects.receive_closed`), which leaves a tombstone unless the
	 * state held is newer, and releases the project's files. A reply
	 * that it isn't open (`ERROR_PROJECT_NOT_OPEN` — e.g. a restart forgot it
	 * and its reopen hasn't succeeded) removes it here too, and the close
	 * always cancels a pending reopen — one in flight closes the project
	 * again once it lands, if its open created it — so a closed project
	 * stays closed.
	 *
	 * @returns the RPC result — any failure but "not open" is for the caller to surface
	 */
	async close_project(
		root: DiskfileDirectoryPath
	): Promise<Result<{ value: null }, { error: JsonrpcErrorObject }>> {
		this.#projects_to_reopen.delete(root);
		if (this.#projects_reopening.has(root)) this.#projects_reopen_cancelled.add(root);
		const result = await this.api.project_close({ root });
		if (result.ok) {
			this.projects.receive_closed(root, result.value.rev);
			return { ok: true, value: null };
		}
		const { reason } = (result.error.data ?? {}) as { reason?: unknown };
		if (reason !== ERROR_PROJECT_NOT_OPEN) return result;
		this.projects.remove_by_root(root);
		return { ok: true, value: null };
	}

	/**
	 * Handles a `project_changed` close at `rev` — another client's or this
	 * one's: applies it (`Projects.receive_closed`) and, unless the project
	 * held was opened again after it, cancels a reopen of it, pending or in
	 * flight (one that lands anyway is closed again if its open created it,
	 * see `#reopen_project`).
	 */
	receive_project_closed(root: DiskfileDirectoryPath, rev: number): void {
		if (!this.projects.receive_closed(root, rev)) return;
		this.#projects_to_reopen.delete(root);
		if (this.#projects_reopening.has(root)) this.#projects_reopen_cancelled.add(root);
	}

	/**
	 * Reopens a project a restarted backend lost: one open of its root,
	 * requesting the rest of `paths` — the directories it had focused — as
	 * its focus, and reconciling the files. It's reopened once the open lands
	 * on its root; a focus refused then (`refused`) is dropped from its focus,
	 * except one that couldn't be indexed for a passing cause
	 * (`ERROR_REPO_INDEX_FAILED`), kept with the rest for the next session
	 * snapshot to retry. When the open is refused — the root is gone or
	 * forbidden, the registry can't be used — or resolves to another project
	 * (which is then open), the project and the files only it covered are
	 * dropped; when it fails otherwise, it's kept for the next snapshot to
	 * retry, so nothing loops. A close while it's in flight wins — this
	 * client's `close_project`, or another's, which removes the project here:
	 * a reopen that lands anyway is closed again when its own open created
	 * the project (`ProjectOpened.opened`). One that merged into a project
	 * open already was opened by someone else after the close, which stands.
	 */
	async #reopen_project(
		root: DiskfileDirectoryPath,
		paths: ReadonlyArray<DiskfileDirectoryPath>
	): Promise<void> {
		this.#projects_to_reopen.set(root, [...paths]);
		this.#projects_reopening.add(root);
		let reopened = false;
		let opened = false;
		let failed: Array<DiskfileDirectoryPath> = [];
		let cancelled = false;
		try {
			let error: JsonrpcErrorObject | null = null;
			try {
				const result = await this.projects.open(root, {
					reconcile_files: true,
					focus: paths.filter((path) => path !== root)
				});
				if (!result.ok) {
					error = result.error;
				} else if (result.value.project?.root === root) {
					reopened = true;
					// created by this open, and nothing changed it since — a newer state
					// held means someone acted on it after the close, which stands
					opened = result.value.opened && result.value.project.rev === result.value.rev;
					for (const { dir, reason } of result.value.refused) {
						if (reason === ERROR_REPO_INDEX_FAILED) failed.push(dir);
					}
				}
			} catch (thrown) {
				error = { code: JSONRPC_ERROR_CODES.internal_error, message: to_error_message(thrown) };
			}
			if (error && !this.#disposed) {
				console.error(`[frontend] failed to reopen ${root} after zzzd restarted:`, error);
				if (!PROJECT_REOPEN_REFUSAL_CODES.has(error.code)) failed = [...paths];
			}
		} finally {
			this.#projects_reopening.delete(root);
			// closed here, or by another client (its `project_changed` removed it)
			cancelled = this.#projects_reopen_cancelled.delete(root) || !this.projects.get_by_root(root);
		}
		if (cancelled || this.#disposed) {
			this.#projects_to_reopen.delete(root);
			this.#projects_restarted_while_reopening.delete(root);
			if (reopened && opened && cancelled && !this.#disposed) {
				// closed while in flight, and this open created it after the close
				// — close it again
				const closed = await this.close_project(root);
				if (!closed.ok) {
					console.error(`[frontend] failed to close reopened project ${root}:`, closed.error);
				}
			}
			return;
		}
		if (failed.length) {
			this.#projects_to_reopen.set(root, failed);
		} else {
			this.#projects_to_reopen.delete(root);
		}
		// a refused focus won't come back: the reply's focus, applied by its rev,
		// lacks it, and its files were released (`Projects`) — only the failed
		// ones are kept to retry
		const project = this.projects.get_by_root(root);
		if (this.#projects_restarted_while_reopening.delete(root) && project) {
			// the open landed on the instance that restarted since — its rev says
			// nothing of the new one's, so forget it; queue the whole focus
			// again, and ask for the snapshot that retries it
			project.rev = -1;
			const again = Array.from(new Set([...project.reopen_paths, ...failed]));
			this.#projects_to_reopen.set(root, again);
			this.resync_session();
			return;
		}
		if (reopened || failed.length) return;
		// its files go but what another root covers — a project the reopen
		// resolved to instead, say
		this.projects.remove_by_root(root);
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
	 * ends a recording, stops `session_load` retries and the cells that own
	 * timers, then unregisters.
	 */
	override dispose(): void {
		this.#disposed = true;
		this.#clear_session_retry();
		this.#clear_session_boot();
		this.socket.disconnect();
		// closes the microphone: a recording doesn't outlive its session
		this.recorder.dispose();
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
