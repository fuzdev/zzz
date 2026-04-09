// @slop claude_sonnet_4

import {z} from 'zod';
import type {AsyncStatus} from '@fuzdev/fuz_util/async.js';
import {BROWSER, DEV} from 'esm-env';
import {SvelteSet} from 'svelte/reactivity';

import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';
import {get_datetime_now, create_uuid} from './zod_helpers.js';
import {
	OLLAMA_URL,
	OllamaShowResponse,
	OllamaListResponse,
	OllamaPsResponse,
	OllamaPsResponseItem,
	OllamaDeleteRequest,
	OllamaShowRequest,
	extract_parameter_count,
} from './ollama_helpers.js';
import {ModelName, type Model} from './model.svelte.js';
import {Poller} from './poller.svelte.js';
import {create_map_by_property} from './iterable_helpers.js';

// TODO IDK about the `handle_` prefix for methods called by the action handlers, maybe rethink
// some things

// TODO the async methods need to be de-duped,
// returning current promises (maybe using deferred pattern),
// like checking the status in the methods

// TODO rough logging

// TODO @many get and display Ollama version, JS API client doesnt have it but the REST API does

const NO_RESPONSE_ERROR_MESSAGE = 'no response from Ollama server';

export const OllamaJson = CellJson.extend({
	host: z.string().default(OLLAMA_URL),
}).meta({cell_class_name: 'Ollama'});
export type OllamaJson = z.infer<typeof OllamaJson>;
export type OllamaJsonInput = z.input<typeof OllamaJson>;

export type OllamaOptions = CellOptions<typeof OllamaJson>;

/**
 * Ollama client state management with simplified API.
 * Model data is stored in `app.models`, not here.
 *
 * ## Status Display Pattern
 *
 * For unified status display (available/unavailable/checking), components should use:
 * - `app.capabilities.ollama.status` - unified status (prioritizes provider status)
 * - `app.capabilities.ollama.error_message` - unified error message
 *
 * This ensures consistency with other providers (Claude, ChatGPT, Gemini) and maintains
 * a single source of truth. The `Capabilities` layer prioritizes backend provider status
 * (authoritative - checks if Ollama is installed) over action-level status (checks if API responds).
 *
 * The lower-level properties here (`list_status`, `list_error`, `provider_error`, etc.) are
 * operational state that `capabilities.ollama` derives from. Use these for:
 * - Operational state (models, pulling, creating, etc.)
 * - Action-specific error handling
 * - Internal state management
 */
export class Ollama extends Cell<typeof OllamaJson> {
	// Private serializable state
	#host: string = $state.raw()!;

	// Runtime-only state
	list_response: OllamaListResponse | null = $state.raw(null);
	list_status: AsyncStatus = $state.raw('initial');
	list_error: string | null = $state.raw(null);
	list_last_updated: number | null = $state.raw(null);
	list_round_trip_time: number | null = $state.raw(null);
	last_refreshed: string | null = $state.raw(null);

	// Track if Ollama has ever successfully responded
	ever_responded: boolean = $state.raw(false);

	// PS (running models) state
	ps_response: OllamaPsResponse | null = $state.raw(null);
	ps_status: AsyncStatus = $state.raw('initial');
	ps_error: string | null = $state.raw(null);
	ps_polling_enabled: boolean = $state.raw(false);

	readonly #ps_poller: Poller;

	// Pull model state
	pull_model_name: string = $state.raw('');
	pull_insecure: boolean = $state.raw(false);
	readonly pulling_models: SvelteSet<string> = new SvelteSet();

	// Copy model state
	copy_source_model: string = $state.raw('');
	copy_destination_model: string = $state.raw('');
	copy_is_copying: boolean = $state.raw(false);

	// Create model state
	create_model_name: string = $state.raw('');
	create_from_model: string = $state.raw('');
	create_system_prompt: string = $state.raw('');
	create_template: string = $state.raw('');
	create_is_creating: boolean = $state.raw(false);

	// Manager view state
	manager_selected_view: 'configure' | 'model' | 'pull' | 'copy' | 'create' =
		$state.raw('configure');
	// TODO maybe should be an id and serialized? think about this when dealing with adding routes
	// for navigation
	manager_selected_model: Model | null = $state.raw(null);
	manager_last_active_view: {view: string; model: Model | null} | null = $state.raw(null);

	// UI state for actions
	show_read_actions: boolean = $state.raw(false);

	// Getters and setters for serializable state
	get host(): string {
		return this.#host;
	}
	set host(value: string) {
		this.#host = OllamaJson.shape.host.parse(value);
	}

	// Derived state
	readonly available: boolean = $derived(
		this.list_status === 'success' ||
			this.ps_status === 'success' ||
			(this.ever_responded && (this.list_status === 'pending' || this.ps_status === 'pending')),
	);

	// TODO maybe move this to an index for automatic filtering/sorting?
	readonly actions = $derived(
		this.app.actions.items.values
			.filter((a) => a.method.startsWith('ollama_'))
			.sort((a, b) => (a.created > b.created ? -1 : 1)),
	);
	readonly pending_actions = $derived(
		this.actions.filter((a) => a.action_event_data?.step === 'handling'),
	);
	readonly completed_actions = $derived(
		this.actions.filter(
			(a) => a.action_event_data?.step === 'handled' || a.action_event_data?.step === 'failed',
		),
	);
	readonly filtered_actions = $derived(
		this.show_read_actions
			? this.actions
			: this.actions.filter(
					// TODO maybe add a helper? `is_ollama_read_action`
					(a) =>
						a.method !== 'ollama_list' && a.method !== 'ollama_show' && a.method !== 'ollama_ps',
				),
	);

	readonly models: Array<Model> = $derived(this.app.models.items.where('provider_name', 'ollama'));

	readonly models_downloaded = $derived(this.models.filter((m) => m.downloaded));
	readonly models_not_downloaded = $derived(this.models.filter((m) => !m.downloaded));

	readonly model_by_name: Map<ModelName, Model> = $derived(
		create_map_by_property(this.models, 'name'),
	);

	readonly model_names: Array<ModelName> = $derived(Array.from(this.model_by_name.keys()));

	// `ps` derived state
	readonly running_models: Array<OllamaPsResponseItem> = $derived(this.ps_response?.models ?? []);
	readonly running_model_names: Set<ModelName> = $derived(
		new Set(this.running_models.map((m) => m.name)),
	);

	// TODO the prefix naming is awkward but sometimes useful, but inconsistently used
	// `pull` model derived state
	readonly pull_parsed_model_name: ModelName = $derived(ModelName.parse(this.pull_model_name));
	readonly pull_already_downloaded: boolean = $derived(
		!!(
			this.pull_parsed_model_name && this.model_by_name.get(this.pull_parsed_model_name)?.downloaded
		),
	);
	readonly pull_can_pull: boolean = $derived(
		!!this.pull_parsed_model_name &&
			!this.pull_already_downloaded &&
			!this.pulling_models.has(this.pull_parsed_model_name),
	);

	pull_is_pulling(model_name: ModelName): boolean {
		return this.pulling_models.has(model_name);
	}

	// `copy` model derived state
	readonly copy_parsed_source_model: ModelName = $derived(ModelName.parse(this.copy_source_model));
	readonly copy_parsed_destination_model: ModelName = $derived(
		ModelName.parse(this.copy_destination_model),
	);
	readonly copy_is_duplicate_name: boolean = $derived(
		!!this.copy_parsed_destination_model &&
			this.model_by_name.has(this.copy_parsed_destination_model),
	);
	readonly copy_destination_model_changed: boolean = $derived(
		!!this.copy_parsed_source_model &&
			!!this.copy_parsed_destination_model &&
			!this.copy_is_duplicate_name,
	);

	// `create` model derived state
	readonly create_parsed_model_name: ModelName = $derived(ModelName.parse(this.create_model_name));
	readonly create_is_duplicate_name: boolean = $derived(
		!!this.create_parsed_model_name && this.model_by_name.has(this.create_parsed_model_name),
	);
	readonly create_can_create: boolean = $derived(
		!!this.create_parsed_model_name && !this.create_is_duplicate_name,
	);

	constructor(options: OllamaOptions) {
		super(OllamaJson, options);

		this.#ps_poller = new Poller({
			poll_fn: () => {
				if (this.ps_polling_enabled && this.available) {
					void this.app.api.ollama_ps();
				}
			},
			immediate: true,
		});

		this.init();
	}

	override dispose(): void {
		this.#ps_poller.dispose(); // TODO maybe add a generic cell unsubscriber/dispose method
		// collection?
		super.dispose();
	}

	/**
	 * Refresh the list of models and ps info and update the refresh timestamp.
	 * Error handlers update state automatically.
	 *
	 * If Ollama provider status indicates unavailability, skip API calls to avoid
	 * overwriting the provider status with action error messages.
	 */
	async refresh(): Promise<{
		list_response: OllamaListResponse | null;
		ps_response: OllamaPsResponse | null;
	}> {
		// Check if Ollama provider is available before making API calls
		const provider_status = this.app.lookup_provider_status('ollama');
		if (!provider_status?.available) {
			return {list_response: null, ps_response: null};
		}

		const [list_result, ps_result] = await Promise.all([
			this.app.api.ollama_list(),
			this.app.api.ollama_ps(),
		]);

		// Handlers already updated state on success/error
		const list_response = list_result.ok ? list_result.value : null;
		const ps_response = ps_result.ok ? ps_result.value : null;

		if (list_result.ok || ps_result.ok) {
			this.last_refreshed = get_datetime_now();
		}

		return {list_response, ps_response};
	}

	/**
	 * Start polling for running models status.
	 * Default interval is 10 seconds.
	 */
	start_ps_polling(options?: {immediate?: boolean; interval?: number}): void {
		if (!BROWSER || this.ps_polling_enabled) return;

		this.ps_polling_enabled = true;
		console.log('[ollama.start_ps_polling] starting ps polling');

		this.#ps_poller.start(options);
	}

	/**
	 * Stop polling for running models status.
	 */
	stop_ps_polling(): void {
		if (!BROWSER || !this.ps_polling_enabled) return;

		console.log('[ollama.stop_ps_polling] stopping ps polling');
		this.ps_polling_enabled = false;

		this.#ps_poller.stop();
	}

	/**
	 * Handle the start of a list operation.
	 */
	handle_ollama_list_start(): void {
		console.log('[ollama.handle_ollama_list_start] starting list request');
		this.list_status = 'pending';
	}

	/**
	 * List all models available on the Ollama server and sync with app.models.
	 */
	handle_ollama_list_complete(response: OllamaListResponse | null): void {
		if (!response) {
			console.error('[ollama.handle_ollama_list_complete] no response');
			this.list_response = null;
			this.list_status = 'failure';
			this.list_error = NO_RESPONSE_ERROR_MESSAGE;
			this.list_round_trip_time = null;
			return;
		}

		console.log(
			`[ollama.handle_ollama_list_complete] success, found ${response.models.length} models`,
			response,
		);

		// Parse to log bugs but assign data anyway to avoid breaking the UX
		if (DEV) {
			const parsed = OllamaListResponse.safeParse(response);
			if (!parsed.success) {
				console.error(`[ollama.handle_ollama_list_complete] failed to parse:`, parsed.error);
			}
		}

		this.list_response = response;
		this.list_status = 'success';
		this.list_error = null;
		this.list_last_updated = Date.now();
		this.ever_responded = true;

		// Sync with app.models
		this.#sync_models_with_list_response(response);
	}

	/**
	 * Handle the start of a ps operation.
	 */
	handle_ollama_ps_start(): void {
		console.log('[ollama.handle_ollama_ps_start] starting ps request');
		this.ps_status = 'pending';
	}

	/**
	 * Get the list of currently running models.
	 */
	handle_ollama_ps_complete(response: OllamaPsResponse | null): void {
		if (!response) {
			console.error('[ollama.handle_ollama_ps_complete] no response');
			this.ps_response = null;
			this.ps_status = 'failure';
			this.ps_error = NO_RESPONSE_ERROR_MESSAGE;
			return;
		}

		console.log(
			`[ollama.handle_ollama_ps_complete] success, found ${response.models.length} running models`,
			response,
		);

		// Parse to log bugs but assign data anyway to avoid breaking the UX
		if (DEV) {
			const parsed = OllamaPsResponse.safeParse(response);
			if (!parsed.success) {
				console.error(`[ollama.handle_ollama_ps_complete] failed to parse:`, parsed.error);
			}
		}

		this.ps_response = response;
		this.ps_status = 'success';
		this.ps_error = null;
		this.ever_responded = true;
	}

	/**
	 * Get detailed information about a specific model.
	 */
	handle_ollama_show(request: OllamaShowRequest, response: OllamaShowResponse | null): void {
		const model = this.app.models.find_by_name(request.model);
		if (!model) {
			console.error(`[ollama.handle_ollama_show] model not found: ${request.model}`);
			return;
		}
		if (model.provider_name !== 'ollama') {
			console.error(`[ollama.handle_ollama_show] model not an ollama model: ${request.model}`);
			return;
		}

		if (!response) {
			console.error(`[ollama.handle_ollama_show] no response for: ${request.model}`);
			model.ollama_show_response_loading = false;
			model.ollama_show_response_error = NO_RESPONSE_ERROR_MESSAGE;
			return;
		}

		console.log(`[ollama.handle_ollama_show] success for: ${request.model}`, response);

		// Parse to log bugs but assign data anyway to avoid breaking the UX
		if (DEV) {
			const parsed = OllamaShowResponse.safeParse(response);
			if (!parsed.success) {
				console.error(
					`[ollama.handle_ollama_show] failed to parse for ${request.model}:`,
					parsed.error,
				);
			}
		}

		// Update model with details
		// TODO maybe remove to avoid bloat? or is it needed for something
		response.tensors = undefined;
		model.ollama_show_response = response;
		model.ollama_show_response_loaded = true;
		model.ollama_show_response_loading = false;
		model.ollama_show_response_error = undefined;
	}

	/**
	 * Delete a model from the Ollama server.
	 */
	async handle_ollama_delete(request: OllamaDeleteRequest): Promise<void> {
		console.log(`[ollama.handle_ollama_delete] deleting: ${request.model}`);

		// Refresh model list after successful deletion
		await this.refresh();
	}

	/**
	 * Clear details for a specific model.
	 */
	clear_model_details(model: Model): void {
		if (model.provider_name === 'ollama') {
			model.ollama_show_response = undefined;
			model.ollama_show_response_loaded = false;
			model.ollama_show_response_error = undefined;
		}
	}

	/**
	 * Clear all model details.
	 */
	clear_all_model_details(): void {
		for (const model of this.models) {
			this.clear_model_details(model);
		}
	}

	/**
	 * Submit pull model form.
	 */
	async pull(): Promise<void> {
		if (!this.pull_can_pull) return;

		const result = await this.app.api.ollama_pull({
			model: this.pull_parsed_model_name,
			insecure: this.pull_insecure,
			_meta: {progressToken: create_uuid()},
		});

		// Handler already updated state on error
		if (!result.ok) return;

		// Success: refresh to update model list
		await this.refresh();
	}

	/**
	 * Submit copy model form.
	 */
	async copy(): Promise<void> {
		if (!this.copy_destination_model_changed) return;

		const result = await this.app.api.ollama_copy({
			source: this.copy_parsed_source_model,
			destination: this.copy_parsed_destination_model,
		});

		// Handler already updated state on error
		if (!result.ok) return;
	}

	/**
	 * Submit create model form.
	 */
	async create(): Promise<void> {
		if (!this.create_can_create) return;

		const result = await this.app.api.ollama_create({
			model: this.create_parsed_model_name,
			from: this.create_from_model.trim() || undefined,
			system: this.create_system_prompt.trim() || undefined,
			template: this.create_template.trim() || undefined,
			_meta: {progressToken: create_uuid()},
		});

		// Handler already updated state on error
		if (!result.ok) return;
	}

	/**
	 * Submit delete model form.
	 */
	async delete(model_name: ModelName): Promise<void> {
		console.log(`[ollama.delete_model] deleting from manager: ${model_name}`);
		const result = await this.app.api.ollama_delete({model: model_name});
		// Handler already updated state on error
		if (!result.ok) return;

		// Clear selection if the deleted model was selected
		if (this.manager_selected_model?.name === model_name) {
			this.set_manager_view('configure', null);
		}
	}

	/**
	 * Unload a model from memory.
	 */
	async unload(model_name: ModelName): Promise<void> {
		console.log(`[ollama.unload] unloading from memory: ${model_name}`);
		const result = await this.app.api.ollama_unload({model: model_name});
		// Handler already updated state on error
		if (!result.ok) return;

		// Best-effort refresh of running models (Ollama may not reflect changes immediately)
		await this.app.api.ollama_ps(); // TODO Ollama doesnt seem to be updated by this time
	}

	/**
	 * Select model in manager.
	 */
	async select(model: Model): Promise<void> {
		this.set_manager_view('model', model);
		// Auto-load details if not already loaded
		if (model.needs_ollama_details) {
			const result = await this.app.api.ollama_show({model: model.name});
			// Handler already updated state on success/error
			if (!result.ok) return;
		}
	}

	/**
	 * Handle close form in manager.
	 */
	close_form(): void {
		this.set_manager_view('configure', null);
	}

	/**
	 * Set the manager view and optionally the selected model.
	 */
	set_manager_view(view: typeof this.manager_selected_view, model?: Model | null): void {
		// Store the previous view as the last active view if it's not 'configure'
		if (this.manager_selected_view !== 'configure' && this.manager_selected_view !== view) {
			this.manager_last_active_view = {
				view: this.manager_selected_view,
				model: this.manager_selected_model,
			};
		}
		this.manager_selected_view = view;
		if (model !== undefined) {
			this.manager_selected_model = model;
		}
	}

	/**
	 * Navigate back to the last active view.
	 */
	manager_back_to_last_view(): void {
		if (this.manager_last_active_view) {
			const view_to_restore = this.manager_last_active_view;
			this.manager_last_active_view = null; // Clear history
			this.manager_selected_view = view_to_restore.view as typeof this.manager_selected_view;
			this.manager_selected_model = view_to_restore.model;
		}
	}

	// Private methods

	/**
	 * Sync the list response with app.models.
	 */
	#sync_models_with_list_response(response: OllamaListResponse): void {
		// Get current ollama models for comparison
		const existing_models = new Map(this.models.map((m) => [m.name, m]));

		// Update or add models
		for (const m of response.models) {
			const existing = existing_models.get(m.name);

			if (existing) {
				// Update existing model with fresh data
				existing.filesize = m.size / (1024 * 1024 * 1024); // Convert bytes to GB
				existing.ollama_list_response_item = m;
				existing_models.delete(m.name);
			} else {
				// Add new model
				this.app.models.add({
					name: m.name,
					provider_name: 'ollama',
					filesize: m.size / (1024 * 1024 * 1024), // Convert bytes to GB
					// Extract some info from details if available
					parameter_count: extract_parameter_count(m.details?.parameter_size),
					architecture: m.details?.family,
					ollama_list_response_item: m,
				});
			}
		}

		// Remove models that no longer exist in Ollama
		for (const removed_model of existing_models.values()) {
			removed_model.ollama_list_response_item = undefined;
			this.clear_model_details(removed_model);
			// We keep the model but the state will show as not downloaded
		}
	}
}
