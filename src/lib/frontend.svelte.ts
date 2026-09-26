import { create_context } from '@fuzdev/fuz_ui/context_helpers.ts';
import { SvelteMap } from 'svelte/reactivity';
import { z } from 'zod';
import { EMPTY_OBJECT } from '@fuzdev/fuz_util/object.ts';
import type { AsyncStatus } from '@fuzdev/fuz_util/async.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import type { Assignable, ClassConstructor, OmitStrict } from '@fuzdev/fuz_util/types.ts';
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
import { Terminals } from './terminals.svelte.ts';
import { TerminalPresets } from './terminal_presets.svelte.ts';
import type { ZzzOptions } from './config_helpers.ts';
import { BOTS_DEFAULT } from './config_defaults.ts';
import { DiskfileDirectoryPath, DiskfilePath } from './diskfile_types.ts';
import { cell_classes } from './cell_classes.ts';
import { CellJson } from './cell_types.ts';
import { Ui, UiJson } from './ui.svelte.ts';
import { Cell, type CellOptions } from './cell.svelte.ts';
import { Socket } from './socket.svelte.ts';
import { Capabilities } from './capabilities.svelte.ts';
import { DiskfileHistory } from './diskfile_history.svelte.ts';
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
import type { FrontendActionsApi } from './action_metatypes.ts';
import type { FrontendActionHandlers } from './frontend_action_types.ts';
import { ActionOutputs } from './action_collections.ts';
import { all_action_specs } from './action_specs.ts';
import { create_frontend_action_handlers } from './frontend_action_handlers.ts';

// TODO this is over-used, see also `app_context` for the user pattern
export const frontend_context = create_context<Frontend>();

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

	// Store DiskfileHistory objects by file path
	readonly diskfile_histories: SvelteMap<DiskfilePath, DiskfileHistory> = new SvelteMap();

	/** See into Zzz's future. */
	futuremode = $state.raw(false);

	/**
	 * Status of loading the session snapshot with `load_session` — `'failure'`
	 * while waiting to retry.
	 */
	session_status: AsyncStatus = $state.raw('initial');

	/** Why the last `session_load` failed, cleared when one succeeds. */
	session_error: string | null = $state.raw(null);

	#session_retry_timeout: ReturnType<typeof setTimeout> | null = null;
	#session_retry_count = 0;
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
		for (const constructor of Object.values(cells_to_register)) {
			this.cell_registry.register(constructor);
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
				const action = new Action({
					app: this,
					json: { method: event.spec.method, action_event_data: event.toJSON() }
				});
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
	 * Loads the session snapshot (`session_load`) and applies it, retrying with
	 * backoff (`SESSION_LOAD_RETRY_DELAY` doubling to `SESSION_LOAD_RETRY_DELAY_MAX`)
	 * until one succeeds or the app is disposed. Calling it while a retry waits
	 * retries now.
	 *
	 * Snapshot entries for paths a `filer_change` touched while the request was
	 * in flight are skipped, since the notification is at least as new.
	 *
	 * @returns whether this attempt succeeded
	 */
	async load_session(): Promise<boolean> {
		if (this.#disposed || this.session_status === 'pending') return false;
		this.#clear_session_retry();
		this.session_status = 'pending';

		let error_message: string;
		const changes = this.diskfiles.track_changes();
		try {
			const result = await this.api.session_load();
			changes.stop();
			if (this.#disposed) return false;
			if (result.ok) {
				this.receive_session(result.value.data, changes.paths);
				this.session_status = 'success';
				this.session_error = null;
				this.#session_retry_count = 0;
				return true;
			}
			error_message = result.error.message;
		} catch (error) {
			// a throw sending the request or applying the snapshot is retried like a failed load
			changes.stop();
			if (this.#disposed) return false;
			console.error('[frontend] session load failed:', error);
			error_message = to_error_message(error);
		}

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

	#clear_session_retry(): void {
		if (this.#session_retry_timeout === null) return;
		clearTimeout(this.#session_retry_timeout);
		this.#session_retry_timeout = null;
	}

	// TODO refactor, probably `app.session`
	/**
	 * Applies a session snapshot.
	 *
	 * @param data - the `session_load` output's snapshot
	 * @param skip_paths - paths whose file-tree entries are stale (see `Diskfiles.add_initial`)
	 */
	receive_session(
		data: ActionOutputs['session_load']['data'],
		skip_paths?: ReadonlySet<string>
	): void {
		this.zzz_dir = data.zzz_dir;
		this.scoped_dirs = data.scoped_dirs;
		this.provider_status = data.provider_status;

		if (Array.isArray(data.files)) {
			this.diskfiles.add_initial(data.files, skip_paths);
		}

		if (Array.isArray(data.workspaces)) {
			for (const workspace_data of data.workspaces) {
				this.workspaces.add(workspace_data);
			}
		}
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

	// TODO refactor
	get_diskfile_history(path: DiskfilePath): DiskfileHistory | undefined {
		return this.diskfile_histories.get(path);
	}

	// TODO refactor
	/**
	 * Creates the edit history for `path`, disposing any it replaces.
	 */
	create_diskfile_history(path: DiskfilePath): DiskfileHistory {
		this.diskfile_histories.get(path)?.dispose();
		const history = new DiskfileHistory({ app: this, json: { path } });
		this.diskfile_histories.set(path, history);
		return history;
	}

	// TODO refactor
	/**
	 * Removes and disposes the edit history for `path`.
	 *
	 * @returns whether a history existed
	 */
	delete_diskfile_history(path: DiskfilePath): boolean {
		const history = this.diskfile_histories.get(path);
		if (!history) return false;
		this.diskfile_histories.delete(path);
		history.dispose();
		return true;
	}

	/**
	 * Tear the app down: closes the socket (no reconnect loop is left behind),
	 * stops `session_load` retries and the cells that own timers, then unregisters.
	 */
	override dispose(): void {
		this.#disposed = true;
		this.#clear_session_retry();
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
