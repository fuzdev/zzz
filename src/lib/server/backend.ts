import {Filer} from '@fuzdev/gro/filer.js';
import type {Disknode} from '@fuzdev/gro/disknode.js';
import type {WatcherChange} from '@fuzdev/gro/watch_dir.js';
import {resolve} from 'node:path';
import {Logger} from '@fuzdev/fuz_util/log.js';
import type {BackendProviderOllama} from './backend_provider_ollama.js';
import type {BackendProviderGemini} from './backend_provider_gemini.js';
import type {BackendProviderChatgpt} from './backend_provider_chatgpt.js';
import type {BackendProviderClaude} from './backend_provider_claude.js';
import {ActionRegistry} from '@fuzdev/fuz_app/action_registry.js';
import type {ActionEventPhase, ActionSpecUnion} from '@fuzdev/fuz_app/action_spec.js';

import type {ZzzConfig} from '../config_helpers.js';
import {DiskfileDirectoryPath} from '../diskfile_types.js';
import {ScopedFs} from './scoped_fs.js';
import {ZZZ_DIR, ZZZ_SCOPED_DIRS} from '../constants.js';
import type {BackendActionHandlers} from './backend_action_types.js';
import type {ActionEventEnvironment, ActionExecutor} from '../action_event_types.js';
import type {ActionMethod} from '../action_metatypes.js';
import {create_backend_actions_api, type BackendActionsApi} from './backend_actions_api.js';
import {ActionPeer} from '../action_peer.js';
import type {JsonrpcMessageFromServerToClient} from '../jsonrpc.js';
import type {BackendProvider} from './backend_provider.js';
import {jsonrpc_errors} from '../jsonrpc_errors.js';

// TODO refactor for extensibility
interface BackendProviders {
	ollama: BackendProviderOllama;
	gemini: BackendProviderGemini;
	chatgpt: BackendProviderChatgpt;
	claude: BackendProviderClaude;
}

/**
 * Function type for handling file system changes.
 */
export type FilerChangeHandler = (
	change: WatcherChange,
	disknode: Disknode,
	backend: Backend,
	dir: string,
	filer: Filer,
) => void;

/**
 * Structure to hold a Filer and its cleanup function.
 */
export interface FilerInstance {
	filer: Filer;
	cleanup_promise: Promise<() => void>;
}

export interface BackendOptions {
	/**
	 * Zzz directory path, defaults to `.zzz`.
	 */
	zzz_dir?: string; // TODO @many move this info to path schemas
	/**
	 * Filesystem paths that Zzz can access for user files.
	 * Defaults to `ZZZ_SCOPED_DIRS` from env.
	 */
	scoped_dirs?: Array<string>;
	/**
	 * Configuration for the backend and AI providers.
	 */
	config: ZzzConfig;
	/**
	 * Action specifications that determine what the backend can do.
	 */
	action_specs: Array<ActionSpecUnion>;
	/**
	 * Handler function for processing client messages.
	 */
	action_handlers: BackendActionHandlers;
	/**
	 * Handler function for file system changes.
	 */
	handle_filer_change: FilerChangeHandler;
	/**
	 * Optional logger instance.
	 * Disabled when `null`, and `undefined` falls back to a new `Logger` instance.
	 */
	log?: Logger | null | undefined;
}

/**
 * Server for managing the Zzz application state and handling client messages.
 */
export class Backend implements ActionEventEnvironment {
	readonly executor: ActionExecutor = 'backend';

	/** The full path to the Zzz directory. */
	readonly zzz_dir: DiskfileDirectoryPath;

	/** Filesystem paths that Zzz can access for user files. */
	readonly scoped_dirs: ReadonlyArray<DiskfileDirectoryPath>;

	readonly config: ZzzConfig;

	// TODO @many make transports an option?
	readonly peer: ActionPeer = new ActionPeer({environment: this});

	/**
	 * API for backend-initiated actions.
	 */
	readonly api: BackendActionsApi = create_backend_actions_api(this);

	/**
	 * Scoped filesystem interface that restricts operations to allowed directories.
	 */
	readonly scoped_fs: ScopedFs;

	readonly log: Logger | null;

	// TODO probably extract a `Filers` class to manage these
	// Map of directory paths to their respective Filer instances
	readonly filers: Map<string, FilerInstance> = new Map();

	readonly action_registry;

	/** Available actions. */
	get action_specs(): Array<ActionSpecUnion> {
		return this.action_registry.specs;
	}

	readonly #action_handlers: BackendActionHandlers;

	// TODO wrapper class?
	/** Available AI providers. */
	readonly providers: Array<BackendProvider> = [];

	readonly #handle_filer_change: FilerChangeHandler;

	constructor(options: BackendOptions) {
		this.zzz_dir = DiskfileDirectoryPath.parse(resolve(options.zzz_dir || ZZZ_DIR));

		// Resolve scoped_dirs to absolute paths and parse as DiskfileDirectoryPath
		this.scoped_dirs = Object.freeze(
			(options.scoped_dirs ?? ZZZ_SCOPED_DIRS).map((p) => DiskfileDirectoryPath.parse(resolve(p))),
		);

		this.config = options.config;

		this.action_registry = new ActionRegistry(options.action_specs);
		this.#action_handlers = options.action_handlers;
		this.#handle_filer_change = options.handle_filer_change;

		// ScopedFs uses scoped_dirs for user file access, plus zzz_dir for app data
		this.scoped_fs = new ScopedFs([this.zzz_dir, ...this.scoped_dirs]);

		this.log = options.log === undefined ? new Logger('[backend]') : options.log;

		// TODO maybe do this in an `init` method
		// Set up filer watcher for zzz_dir (always watched for app data)
		const zzz_filer = new Filer({watch_dir_options: {dir: this.zzz_dir}});
		const zzz_cleanup = zzz_filer.watch((change, disknode) => {
			this.#handle_filer_change(change, disknode, this, this.zzz_dir, zzz_filer);
		});
		this.filers.set(this.zzz_dir, {filer: zzz_filer, cleanup_promise: zzz_cleanup});

		// Set up filer watchers for each scoped directory (user files)
		for (const dir of this.scoped_dirs) {
			// Skip if same as zzz_dir (already watching)
			if (dir === this.zzz_dir) continue;

			const filer = new Filer({watch_dir_options: {dir}});
			const cleanup_promise = filer.watch((change, disknode) => {
				this.#handle_filer_change(change, disknode, this, dir, filer);
			});
			this.filers.set(dir, {filer, cleanup_promise});
		}
	}

	// TODO @api better type safety
	lookup_action_handler(
		method: ActionMethod,
		phase: ActionEventPhase,
	): ((event: any) => any) | undefined {
		const method_handlers = this.#action_handlers[method as keyof BackendActionHandlers];
		if (!method_handlers) return undefined;
		return method_handlers[phase as keyof BackendActionHandlers[keyof BackendActionHandlers]];
	}

	lookup_action_spec(method: ActionMethod): ActionSpecUnion | undefined {
		return this.action_registry.spec_by_method.get(method);
	}

	lookup_provider<T extends keyof BackendProviders>(provider_name: T): BackendProviders[T] {
		const provider = this.providers.find((p) => p.name === provider_name);
		if (!provider) {
			throw jsonrpc_errors.invalid_params(`unsupported provider: ${provider_name}`);
		}
		return provider as BackendProviders[T];
	}

	/**
	 * Process a singular JSON-RPC message and return a response.
	 * Like MCP, Zzz breaks from JSON-RPC by not supporting batching.
	 */
	async receive(message: unknown): Promise<JsonrpcMessageFromServerToClient | null> {
		this.#check_destroyed();
		return this.peer.receive(message);
	}

	#destroyed = false;
	get destroyed(): boolean {
		return this.#destroyed;
	}

	// TODO maybe use a decorator for this?
	/** Throws if the backend has been destroyed. */
	#check_destroyed(): void {
		if (this.#destroyed) {
			throw new Error('Server has been destroyed');
		}
	}

	/**
	 * Server teardown and cleanup.
	 */
	async destroy(): Promise<void> {
		if (this.#destroyed) {
			this.log?.warn('Server already destroyed');
			return;
		}
		this.#destroyed = true;

		this.log?.info('Destroying backend');

		// Clean up all filer watchers
		const cleanup_promises: Array<Promise<void>> = [];

		for (const {cleanup_promise} of this.filers.values()) {
			cleanup_promises.push(cleanup_promise.then((cleanup) => cleanup()));
		}

		await Promise.all(cleanup_promises);
	}

	add_provider(provider: BackendProvider): void {
		if (this.providers.some((p) => p.name === provider.name)) {
			throw new Error(`provider with name ${provider.name} already exists`);
		}
		this.providers.push(provider);
		this.log?.info(`added provider: ${provider.name}`);
	}
}
