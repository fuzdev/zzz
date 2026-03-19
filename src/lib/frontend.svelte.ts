import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';
import {SvelteMap} from 'svelte/reactivity';
import {z} from 'zod';
import {EMPTY_OBJECT} from '@fuzdev/fuz_util/object.js';
import type {Assignable, ClassConstructor, OmitStrict} from '@fuzdev/fuz_util/types.js';

import {Provider, type ProviderJsonInput} from './provider.svelte.js';
import type {ProviderStatus} from './provider_types.js';
import {Models} from './models.svelte.js';
import {Chats} from './chats.svelte.js';
import {Threads} from './threads.svelte.js';
import {Providers} from './providers.svelte.js';
import {Diskfiles} from './diskfiles.svelte.js';
import {Actions} from './actions.svelte.js';
import type {ModelJsonInput} from './model.svelte.js';
import {CellRegistry} from './cell_registry.svelte.js';
import {Prompts} from './prompts.svelte.js';
import {Parts} from './parts.svelte.js';
import {Time} from './time.svelte.js';
import {Ollama} from './ollama.svelte.js';
import type {ZzzConfig} from './config_helpers.js';
import {BOTS_DEFAULT} from './config_defaults.js';
import {DiskfileDirectoryPath, DiskfilePath} from './diskfile_types.js';
import {cell_classes} from './cell_classes.js';
import {CellJson} from './cell_types.js';
import {Ui, UiJson} from './ui.svelte.js';
import {Cell, type CellOptions} from './cell.svelte.js';
import {Socket} from './socket.svelte.js';
import {Capabilities} from './capabilities.svelte.js';
import {DiskfileHistory} from './diskfile_history.svelte.js';
import {HANDLED} from './cell_helpers.js';
import {ActionRegistry} from './action_registry.js';
import {ActionPeer} from './action_peer.js';
import type {ActionMethod, ActionsApi} from './action_metatypes.js';
import type {FrontendActionHandlers} from './frontend_action_types.js';
import type {ActionSpecUnion} from './action_spec.js';
import {ActionInputs, ActionOutputs, action_specs} from './action_collections.js';
import {create_frontend_actions_api} from './frontend_actions_api.js';
import {ActionExecutor} from './action_types.js';
import {
	ActionEventPhase,
	ACTION_EVENT_PHASE_BY_KIND,
	type ActionEventEnvironment,
} from './action_event_types.js';
import {FrontendHttpTransport} from './frontend_http_transport.js';
import {FrontendWebsocketTransport} from './frontend_websocket_transport.js';

// TODO this is over-used, see also `app_context` for the user pattern
export const frontend_context = create_context<Frontend>();

export const FrontendJson = CellJson.extend({
	ui: UiJson.default(() => UiJson.parse({})),
	// TODO other state?
}).meta({cell_class_name: 'Frontend'});
export type FrontendJson = z.infer<typeof FrontendJson>;
export type FrontendJsonInput = z.input<typeof FrontendJson>;

export interface FrontendOptions extends OmitStrict<CellOptions<typeof FrontendJson>, 'app'> {
	/** Do not use - optional to avoid circular reference problem. */
	app?: never;
	models?: Array<ModelJsonInput>;
	bots?: ZzzConfig['bots'];
	providers?: Array<ProviderJsonInput>;
	cell_classes?: Record<string, ClassConstructor<Cell<any>>>;
	action_specs?: Array<ActionSpecUnion>;
	action_handlers?: FrontendActionHandlers;

	http_rpc_url?: string | null;
	http_headers?: Record<string, string>;

	socket_url?: string | null;
}

/**
 * The base frontend app, typically used by creating your own `App extends Frontend`.
 * Gettable with `frontend_context.get()` inside a `FrontendRoot`.
 */
export class Frontend extends Cell<typeof FrontendJson> implements ActionEventEnvironment {
	readonly executor: ActionExecutor = 'frontend';

	/**
	 * App-wide cell registry, maps class names to constructor and tracks registered instances.
	 */
	readonly cell_registry: CellRegistry;

	readonly action_registry: ActionRegistry;
	readonly action_handlers: FrontendActionHandlers;
	readonly api: ActionsApi;
	readonly peer: ActionPeer;

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
	readonly ollama: Ollama;

	readonly bots: ZzzConfig['bots'];

	// TODO maybe instead of this pattern with getters/setters, using an encoder?
	#zzz_dir: DiskfileDirectoryPath | null | undefined = $state(null); // TODO should this be undefined?

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

	#scoped_dirs: ReadonlyArray<DiskfileDirectoryPath> = $state([]);

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
	futuremode = $state(false);

	constructor(options: FrontendOptions = EMPTY_OBJECT) {
		// Pass this instance as its own zzz reference - casting hacks around the circular reference
		super(FrontendJson, options as FrontendOptions & {app: Frontend});

		// Set the circular reference now that the object is constructed
		(this as Assignable<typeof this, 'app'>).app = this;

		this.cell_registry = new CellRegistry(this);

		this.action_registry = new ActionRegistry(options.action_specs || action_specs);
		this.action_handlers = options.action_handlers || {};

		// Register cell classes if provided, otherwise use the default
		const cells_to_register = options.cell_classes || cell_classes;
		for (const constructor of Object.values(cells_to_register)) {
			this.cell_registry.register(constructor);
		}

		// Initialize cell collections - the frontend is the root cell
		this.time = new Time({app: this});
		this.ui = new Ui({app: this});
		this.models = new Models({app: this});
		this.chats = new Chats({app: this});
		this.threads = new Threads({app: this});
		this.providers = new Providers({app: this});
		this.prompts = new Prompts({app: this});
		this.parts = new Parts({app: this});
		this.diskfiles = new Diskfiles({app: this});
		this.actions = new Actions({app: this});
		this.socket = new Socket({app: this});
		this.capabilities = new Capabilities({app: this});
		this.ollama = new Ollama({app: this});

		this.bots = options.bots ?? BOTS_DEFAULT;

		this.api = create_frontend_actions_api(this);

		this.peer = new ActionPeer({environment: this});

		// Set up transports, adding websocket first so it'll be the default
		if (options.socket_url) {
			this.socket.connect(options.socket_url);
			this.peer.transports.register_transport(new FrontendWebsocketTransport(this.socket));
		}
		if (options.http_rpc_url) {
			this.peer.transports.register_transport(
				new FrontendHttpTransport(options.http_rpc_url, options.http_headers),
			);
		}

		this.decoders = {
			// TODO do this automatically from the schema?
			ui: (value) => {
				if (value && typeof value === 'object') {
					this.ui.set_json(value);
				}
				return HANDLED;
			},
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

	// TODO refactor, probably `app.session`
	receive_session(data: ActionOutputs['session_load']['data']): void {
		this.zzz_dir = data.zzz_dir;
		this.scoped_dirs = data.scoped_dirs;
		this.provider_status = data.provider_status;

		if (Array.isArray(data.files)) {
			for (const disknode of data.files) {
				this.diskfiles.handle_change({
					change: {type: 'add', path: disknode.id},
					disknode,
				});
			}
		}
	}

	add_providers(providers_json: Array<ProviderJsonInput>): void {
		for (const json of providers_json) {
			this.add_provider(json);
		}
	}

	add_provider(provider_json: ProviderJsonInput): void {
		this.providers.add(new Provider({app: this, json: provider_json}));
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
	create_diskfile_history(path: DiskfilePath): DiskfileHistory {
		const history = new DiskfileHistory({app: this, json: {path}});
		this.diskfile_histories.set(path, history);
		return history;
	}

	lookup_action_handler(
		method: ActionMethod,
		phase: ActionEventPhase,
	): ((event: any) => any) | undefined {
		const method_handlers = (this.action_handlers as any)[method];
		if (!method_handlers) return undefined;
		return method_handlers[phase];
	}

	lookup_action_spec(method: ActionMethod): ActionSpecUnion | undefined {
		return this.action_registry.spec_by_method.get(method);
	}

	lookup_action_input_schema<TMethod extends ActionMethod>(
		method: TMethod,
	): (typeof ActionInputs)[TMethod] | undefined {
		const spec = this.action_registry.spec_by_method.get(method);
		return spec?.input as any;
	}

	lookup_action_output_schema<TMethod extends ActionMethod>(
		method: TMethod,
	): (typeof ActionOutputs)[TMethod] | undefined {
		const spec = this.action_registry.spec_by_method.get(method);
		return spec?.output as any;
	}

	// TODO maybe better type safety here and the `lookup_action_handler` method?
	is_valid_phase_for_method(method: ActionMethod, phase: ActionEventPhase): boolean {
		const spec = this.action_registry.spec_by_method.get(method);
		if (!spec) return false;
		const valid_phases = ACTION_EVENT_PHASE_BY_KIND[spec.kind];
		return valid_phases.includes(phase as never);
	}
}
