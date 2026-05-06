import {z} from 'zod';
import {resolve} from '$app/paths';

import {ProviderName} from './provider_types.js';
import {Cell, type CellOptions} from './cell.svelte.js';
import {CellJson} from './cell_types.js';
import {OllamaShowResponse, OllamaListResponseItem} from './ollama_helpers.js';
import {goto_unless_current} from './navigation_helpers.js';
import type {Provider} from './provider.svelte.js';

export const ModelName = z.string().trim();
export type ModelName = z.infer<typeof ModelName>;

export const ModelJson = CellJson.extend({
	// TODO consider whether we should support one model with multiple providers,
	// or individual models per provider, currently we expect
	// `name` to be unique across providers and this needs to change,
	// I think it's like chats/prompts/etc, names should not be unique,
	// unless we think they're more like file paths? `provider_name/model_name` seems good for `path`?
	// that would make model/provider name like filenames, makes sense
	name: ModelName,
	provider_name: ProviderName,
	tags: z.array(z.string()).default(() => []),

	// TODO expand/improve these
	// fetched from provider APIs:
	architecture: z.string().optional(),
	parameter_count: z.number().optional(),
	context_window: z.number().optional(),
	output_token_limit: z.number().optional(),
	embedding_length: z.number().optional(),
	/** Size in gigabytes. */
	filesize: z.number().optional(),
	cost_input: z.number().optional(),
	cost_output: z.number().optional(),
	training_cutoff: z.string().optional(),
	// TODO @many maybe have a single `ollama` object?
	ollama_list_response_item: OllamaListResponseItem.optional(),
	ollama_show_response: OllamaShowResponse.optional(),
	ollama_show_response_loaded: z.boolean().default(false),
	ollama_show_response_loading: z.boolean().default(false),
	ollama_show_response_error: z.string().optional(),
}).meta({cell_class_name: 'Model'});
export type ModelJson = z.infer<typeof ModelJson>;
export type ModelJsonInput = z.input<typeof ModelJson>;

export interface ModelOptions extends CellOptions<typeof ModelJson> {} // eslint-disable-line @typescript-eslint/no-empty-object-type

export class Model extends Cell<typeof ModelJson> {
	name: ModelName = $state.raw()!;
	provider_name: ProviderName = $state.raw()!;
	tags: Array<string> = $state()!;
	architecture: string | undefined = $state.raw();
	parameter_count: number | undefined = $state.raw();
	context_window: number | undefined = $state.raw();
	output_token_limit: number | undefined = $state.raw();
	embedding_length: number | undefined = $state.raw();
	/** Size in gigabytes. */
	filesize: number | undefined = $state.raw();
	cost_input: number | undefined = $state.raw();
	cost_output: number | undefined = $state.raw();
	training_cutoff: string | undefined = $state.raw();

	// TODO @many maybe have a single `ollama` object?
	// in Ollamaland, list is the metadata and show is the full details
	ollama_list_response_item: OllamaListResponseItem | undefined = $state.raw();
	ollama_show_response: OllamaShowResponse | undefined = $state.raw();
	ollama_show_response_loaded: boolean = $state.raw(false);
	ollama_show_response_loading: boolean = $state.raw(false);
	ollama_show_response_error: string | undefined = $state.raw();

	/**
	 * For models that run locally, this is a boolean indicating if the model is downloaded.
	 * Is `undefined` for non-local models.
	 */
	readonly downloaded: boolean | undefined = $derived(
		this.provider_name === 'ollama' ? !!this.ollama_list_response_item : undefined,
	);

	/**
	 * Lookup the provider for this model.
	 */
	readonly provider: Provider | undefined = $derived(
		this.app.providers.find_by_name(this.provider_name),
	);

	readonly context_window_formatted: string | null = $derived(
		this.context_window ? (this.context_window / 1000).toFixed(0) + 'k' : null,
	);

	// TODO hacky
	/**
	 * Get the modified date from Ollama data if available.
	 */
	readonly ollama_modified_at: Date | undefined = $derived.by(() => {
		const m = this.ollama_list_response_item?.modified_at || this.ollama_show_response?.modified_at;
		return m === undefined ? undefined : typeof m === 'string' ? new Date(m) : m;
	});

	/**
	 * Check if this model needs its details loaded.
	 */
	readonly needs_ollama_details: boolean = $derived(
		this.provider_name === 'ollama' &&
			// TODO maybe separate this check for existence
			!!this.app.ollama.list_response &&
			this.app.ollama.list_response.models.some((m) => m.name === this.name) &&
			!this.ollama_show_response_loaded &&
			!this.ollama_show_response_loading &&
			!this.ollama_show_response_error,
	);

	/**
	 * Check if this model is currently loaded/running.
	 * For Ollama models, this checks if the model is in the running models set.
	 */
	readonly loaded: boolean = $derived(
		this.provider_name === 'ollama' ? this.app.ollama.running_model_names.has(this.name) : false,
	);

	constructor(options: ModelOptions) {
		super(ModelJson, options);
		this.init();
	}

	/**
	 * Download this model. Currently only works for Ollama models.
	 */
	async navigate_to_download(): Promise<void> {
		if (this.provider_name !== 'ollama') {
			console.error(`Download not supported for provider: ${this.provider_name}`);
			return;
		}

		if (this.downloaded) {
			console.error(`Model ${this.name} is already downloaded`);
			return;
		}

		// Set the model name on the Ollama instance and navigate to the providers page
		this.app.ollama.pull_model_name = this.name;
		this.app.ollama.set_manager_view('pull');
		await goto_unless_current(resolve('/providers/ollama'));
	}

	/**
	 * Navigate to the model view. Currently only works for Ollama models.
	 */
	async navigate_to_provider_model_view(): Promise<void> {
		if (this.provider_name !== 'ollama') {
			console.error(`provider model view not supported for provider: ${this.provider_name}`);
			return;
		}

		// Set the selected model and navigate to the model view
		await Promise.all([
			// synchronously select the model but we don't care about
			// waiting for its details to load, currently part of `select`
			this.app.ollama.select(this),
			goto_unless_current(resolve('/providers/ollama')),
		]);
	}
}

export const ModelSchema = z.instanceof(Model);
