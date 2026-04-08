import {Filer} from '@fuzdev/gro/filer.js';
import type {Disknode} from '@fuzdev/gro/disknode.js';
import type {WatcherChange} from '@fuzdev/gro/watch_dir.js';
import {basename, resolve} from 'node:path';
import * as fs from 'node:fs/promises';
import {Logger} from '@fuzdev/fuz_util/log.js';
import type {BackendProviderOllama} from './backend_provider_ollama.js';
import type {BackendProviderGemini} from './backend_provider_gemini.js';
import type {BackendProviderChatgpt} from './backend_provider_chatgpt.js';
import type {BackendProviderClaude} from './backend_provider_claude.js';
import {ActionRegistry} from '@fuzdev/fuz_app/actions/action_registry.js';
import type {ActionEventPhase, ActionSpecUnion} from '@fuzdev/fuz_app/actions/action_spec.js';

import type {ZzzOptions} from '../config_helpers.js';
import {DiskfileDirectoryPath} from '../diskfile_types.js';
import type {WorkspaceInfoJson} from '../workspace.svelte.js';
import {ScopedFs} from './scoped_fs.js';
import type {BackendActionHandlers} from './backend_action_types.js';
import type {ActionEventEnvironment, ActionExecutor} from '../action_event_types.js';
import type {ActionMethod} from '../action_metatypes.js';
import {create_backend_actions_api, type BackendActionsApi} from './backend_actions_api.js';
import {PtyManager} from './backend_pty_manager.js';
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
	 */
	scoped_dirs?: Array<string>;
	/**
	 * Configuration for the backend and AI providers.
	 */
	config: ZzzOptions;
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

	readonly config: ZzzOptions;

	// TODO @many make transports an option?
	readonly peer: ActionPeer = new ActionPeer({environment: this});

	/**
	 * API for backend-initiated actions.
	 */
	readonly api: BackendActionsApi = create_backend_actions_api(this);

	/**
	 * Manages spawned PTY processes for terminal integration.
	 */
	readonly pty_manager: PtyManager;

	/**
	 * `ScopedFs` filesystem interface that restricts operations to allowed directories.
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
		this.zzz_dir = DiskfileDirectoryPath.parse(resolve(options.zzz_dir || '.zzz'));

		// Resolve scoped_dirs to absolute paths and parse as DiskfileDirectoryPath
		this.scoped_dirs = Object.freeze(
			(options.scoped_dirs ?? []).map((p) => DiskfileDirectoryPath.parse(resolve(p))),
		);

		this.config = options.config;

		this.action_registry = new ActionRegistry(options.action_specs);
		this.#action_handlers = options.action_handlers;
		this.#handle_filer_change = options.handle_filer_change;

		// ScopedFs uses scoped_dirs for user file access, plus zzz_dir for app data
		this.scoped_fs = new ScopedFs([this.zzz_dir, ...this.scoped_dirs]);

		this.log = options.log === undefined ? new Logger('[backend]') : options.log;

		this.pty_manager = new PtyManager({api: this.api, log: this.log});

		// TODO maybe do this in an `init` method
		// Set up filer watcher for zzz_dir (always watched for app data)
		this.#start_filer(this.zzz_dir);

		// Set up filer watchers for each scoped directory (user files)
		for (const dir of this.scoped_dirs) {
			if (dir === this.zzz_dir) continue; // already watching
			this.#start_filer(dir);
		}

		// Restore persisted workspaces — session_load awaits this to avoid partial results
		// TODO consider lazy activation — only start Filers when a client connects or requests workspace data
		this.#workspaces_ready = this.#restore_workspaces();
	}

	/** Resolves when persisted workspaces have been restored. */
	readonly #workspaces_ready: Promise<void>;

	/**
	 * Start a Filer for the given directory and register it.
	 * Returns existing instance if already watching this directory.
	 */
	#start_filer(dir: string): FilerInstance {
		const existing = this.filers.get(dir);
		if (existing) return existing;

		const filer = new Filer({watch_dir_options: {dir}});
		const cleanup_promise = filer.watch((change, disknode) => {
			this.#handle_filer_change(change, disknode, this, dir, filer);
		});
		const instance: FilerInstance = {filer, cleanup_promise};
		this.filers.set(dir, instance);
		return instance;
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

		// Kill all terminal processes
		await this.pty_manager.destroy();

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

	// -- Workspace management --
	// TODO: extract to a Workspaces manager class (like PtyManager) when complexity grows

	/** Tracks open workspaces by path. */
	readonly workspaces: Map<string, WorkspaceInfoJson> = new Map();

	/** Suppresses persistence during restore to avoid N redundant writes. */
	#restoring_workspaces = false;

	/**
	 * Open a workspace directory — adds to ScopedFs, starts a Filer, and persists.
	 *
	 * @param path - absolute directory path
	 * @param opened_at - optional timestamp to preserve (e.g. from persisted state)
	 * @returns the workspace info (existing or newly created)
	 */
	async workspace_open(path: string, opened_at?: string): Promise<WorkspaceInfoJson> {
		const resolved = DiskfileDirectoryPath.parse(resolve(path));

		// Already open?
		const existing = this.workspaces.get(resolved);
		if (existing) return existing;

		// Validate the directory exists
		try {
			const stat = await fs.stat(resolved);
			if (!stat.isDirectory()) {
				throw new Error(`not a directory: ${resolved}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new Error(`directory does not exist: ${resolved}`);
			}
			throw error;
		}

		// Add to ScopedFs and start watching
		this.scoped_fs.add_path(resolved);
		this.#start_filer(resolved);

		const info: WorkspaceInfoJson = {
			path: resolved,
			name: basename(resolved.replace(/\/$/, '')),
			opened_at: opened_at ?? new Date().toISOString(),
		};
		this.workspaces.set(resolved, info);

		this.log?.info(`workspace opened: ${resolved}`);

		if (!this.#restoring_workspaces) {
			void this.#persist_workspaces();
		}

		return info;
	}

	/**
	 * Close a workspace directory — stops Filer, removes from ScopedFs, and persists.
	 * Preserves Filers and ScopedFs entries for initial scoped_dirs.
	 */
	async workspace_close(path: string): Promise<boolean> {
		const resolved = DiskfileDirectoryPath.parse(resolve(path));

		if (!this.workspaces.has(resolved)) return false;

		const is_initial_scoped_dir = this.scoped_dirs.includes(resolved);

		// Only stop the Filer if it wasn't started for an initial scoped_dir
		if (!is_initial_scoped_dir) {
			const filer_instance = this.filers.get(resolved);
			if (filer_instance) {
				const cleanup = await filer_instance.cleanup_promise;
				cleanup();
				this.filers.delete(resolved);
			}

			this.scoped_fs.remove_path(resolved);
		}

		this.workspaces.delete(resolved);

		this.log?.info(`workspace closed: ${resolved}`);

		// Persist in background
		void this.#persist_workspaces();

		return true;
	}

	/**
	 * Wait for persisted workspaces to finish restoring.
	 * Call before returning workspace data to clients.
	 */
	async workspaces_ready(): Promise<void> {
		await this.#workspaces_ready;
	}

	/**
	 * List all open workspaces.
	 */
	workspace_list(): Array<WorkspaceInfoJson> {
		return Array.from(this.workspaces.values());
	}

	/** Path to the workspaces persistence file. */
	get #workspaces_file(): string {
		return `${this.zzz_dir}state/workspaces.json`;
	}

	/**
	 * Persist open workspaces to disk.
	 */
	async #persist_workspaces(): Promise<void> {
		try {
			const data = JSON.stringify(this.workspace_list(), null, '\t');
			// Ensure state directory exists
			await fs.mkdir(`${this.zzz_dir}state`, {recursive: true});
			await fs.writeFile(this.#workspaces_file, data, 'utf8');
		} catch (error) {
			this.log?.warn(`failed to persist workspaces: ${error}`);
		}
	}

	/**
	 * Restore persisted workspaces from disk on startup.
	 * Re-opens each workspace (registers with ScopedFs, starts Filer).
	 * Silently skips workspaces whose directories no longer exist.
	 */
	async #restore_workspaces(): Promise<void> {
		try {
			const raw = await fs.readFile(this.#workspaces_file, 'utf8');
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return;

			this.#restoring_workspaces = true;
			try {
				for (const entry of parsed) {
					if (!entry?.path) continue;
					try {
						await this.workspace_open(entry.path, entry.opened_at); // eslint-disable-line no-await-in-loop
					} catch (error) {
						// directory may have been removed — skip silently
						this.log?.warn(`skipping persisted workspace ${entry.path}: ${error instanceof Error ? error.message : error}`);
					}
				}
			} finally {
				this.#restoring_workspaces = false;
			}

			this.log?.info(`restored ${this.workspaces.size} workspace(s)`);
		} catch (error) {
			// No persisted file or invalid JSON — start fresh
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.log?.warn(`failed to restore workspaces: ${error}`);
			}
		}
	}
}
