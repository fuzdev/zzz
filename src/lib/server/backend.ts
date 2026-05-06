import {Filer} from '@fuzdev/gro/filer.js';
import type {Disknode} from '@fuzdev/gro/disknode.js';
import type {WatcherChange} from '@fuzdev/gro/watch_dir.js';
import {basename, resolve} from 'node:path';
import * as fs from 'node:fs/promises';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {ActionRegistry} from '@fuzdev/fuz_app/actions/action_registry.js';
import type {ActionSpecUnion} from '@fuzdev/fuz_app/actions/action_spec.js';
import {jsonrpc_errors} from '@fuzdev/fuz_app/http/jsonrpc_errors.js';
import type {
	ActionEventEnvironment,
	ActionExecutor,
} from '@fuzdev/fuz_app/actions/action_event_types.js';
import {ActionPeer} from '@fuzdev/fuz_app/actions/action_peer.js';

import type {BackendProviderOllama} from './backend_provider_ollama.js';
import type {BackendProviderGemini} from './backend_provider_gemini.js';
import type {BackendProviderChatgpt} from './backend_provider_chatgpt.js';
import type {BackendProviderClaude} from './backend_provider_claude.js';
import type {ZzzOptions} from '../config_helpers.js';
import {DiskfileDirectoryPath, type SerializableDisknode} from '../diskfile_types.js';
import {to_serializable_disknode} from '../diskfile_helpers.js';
import type {WorkspaceInfoJson} from '../workspace.svelte.js';
import {ScopedFs} from './scoped_fs.js';
import type {ActionMethod} from '../action_metatypes.js';
import {create_backend_actions_api} from './backend_actions_api.js';
import type {BackendActionsApi} from './backend_action_types.js';
import {PtyManager} from './backend_pty_manager.js';
import type {BackendProvider} from './backend_provider.js';

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

	// Shim — Backend implements ActionEventEnvironment for ActionPeer,
	// but no backend code path calls ActionEvent.handle_async().
	lookup_action_handler(): undefined {
		return undefined;
	}

	lookup_action_spec(method: string): ActionSpecUnion | undefined {
		return this.action_registry.spec_by_method.get(method as ActionMethod);
	}

	lookup_provider<T extends keyof BackendProviders>(provider_name: T): BackendProviders[T] {
		const provider = this.providers.find((p) => p.name === provider_name);
		if (!provider) {
			throw jsonrpc_errors.invalid_params(`unsupported provider: ${provider_name}`);
		}
		return provider as BackendProviders[T];
	}

	#destroyed = false;
	get destroyed(): boolean {
		return this.#destroyed;
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
	 * @returns the workspace info and initial file tree
	 */
	async workspace_open(
		path: string,
		opened_at?: string,
	): Promise<{workspace: WorkspaceInfoJson; files: Array<SerializableDisknode>}> {
		const resolved = DiskfileDirectoryPath.parse(resolve(path));

		// Already open? Return existing with current files
		const existing = this.workspaces.get(resolved);
		if (existing) return {workspace: existing, files: this.#collect_filer_files(resolved)};

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
		const filer_instance = this.#start_filer(resolved);

		// TODO: verify cleanup_promise resolves after initial scan completes — if it resolves earlier, files may be empty
		await filer_instance.cleanup_promise;

		const info: WorkspaceInfoJson = {
			path: resolved,
			name: basename(resolved.replace(/\/$/, '')),
			opened_at: opened_at ?? new Date().toISOString(),
		};
		this.workspaces.set(resolved, info);

		this.log?.info(`workspace opened: ${resolved}`);

		if (!this.#restoring_workspaces) {
			void this.#persist_workspaces();
			// TODO: workspace_changed broadcasts to ALL clients including the originator — harmless (workspaces.add deduplicates by path) but wastes a round trip
			void this.api.workspace_changed({type: 'open', workspace: info});
		}

		return {workspace: info, files: this.#collect_filer_files(resolved)};
	}

	/**
	 * Collect all files from a Filer as SerializableDisknode array.
	 */
	#collect_filer_files(dir: string): Array<SerializableDisknode> {
		const filer_instance = this.filers.get(dir);
		if (!filer_instance) return [];
		const files: Array<SerializableDisknode> = [];
		for (const file of filer_instance.filer.files.values()) {
			files.push(to_serializable_disknode(file, dir));
		}
		return files;
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

		const workspace = this.workspaces.get(resolved)!;
		this.workspaces.delete(resolved);

		this.log?.info(`workspace closed: ${resolved}`);

		// Persist in background
		void this.#persist_workspaces();
		void this.api.workspace_changed({type: 'close', workspace});

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
	 * Restore persisted workspaces from disk on startup, then ensure
	 * scoped_dirs are also represented as workspace entries.
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
						await this.workspace_open(entry.path, entry.opened_at);
					} catch (error) {
						// directory may have been removed — skip silently
						this.log?.warn(
							`skipping persisted workspace ${entry.path}: ${error instanceof Error ? error.message : error}`,
						);
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

		// Ensure scoped_dirs have workspace entries — these are derived from
		// env config so we don't persist them (they're re-created each startup)
		this.#ensure_scoped_dir_workspaces();
	}

	/**
	 * Create workspace entries for scoped_dirs that aren't already in the workspace map.
	 * These aren't persisted — they're always derived from env config on startup.
	 */
	#ensure_scoped_dir_workspaces(): void {
		for (const dir of this.scoped_dirs) {
			if (dir === this.zzz_dir) continue; // zzz_dir is internal, not a workspace
			if (this.workspaces.has(dir)) continue;

			const info: WorkspaceInfoJson = {
				path: dir,
				name: basename(dir.replace(/\/$/, '')),
				opened_at: new Date().toISOString(),
			};
			this.workspaces.set(dir, info);
			this.log?.info(`workspace created from scoped_dir: ${dir}`);
		}
	}
}
