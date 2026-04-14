import type {CompletionMessage} from '../completion_types.js';
import type {ActionInputs, ActionOutputs} from '../action_collections.js';
import type {Uuid} from '../zod_helpers.js';
import {jsonrpc_errors} from '../zzz_jsonrpc_errors.js';
import {
	type ProviderStatus,
	PROVIDER_ERROR_NEEDS_API_KEY,
	PROVIDER_ERROR_NOT_INSTALLED,
} from '../provider_types.js';

// TODO proper logging

// TODO centralized error messages for i18n

export type CompletionHandler = (
	options: CompletionHandlerOptions,
) => Promise<ActionOutputs['completion_create']>;

// TODO refactor, how?
export interface CompletionOptions {
	frequency_penalty?: number;
	output_token_max: number;
	presence_penalty?: number;
	seed?: number;
	stop_sequences?: Array<string>;
	system_message: string;
	temperature?: number;
	top_k?: number;
	top_p?: number;
}

// TODO refactor, how?
export interface CompletionHandlerOptions {
	model: string;
	completion_options: CompletionOptions;
	completion_messages: Array<CompletionMessage> | undefined;
	prompt: string;
	/** Opts into streaming notifications when provided. */
	progress_token?: Uuid;
}

export type OnCompletionProgress = (input: ActionInputs['completion_progress']) => Promise<void>;

export interface BackendProviderOptions {
	on_completion_progress: OnCompletionProgress;
	api_key?: string | null;
}

/**
 * Base class for all backend AI providers.
 * Provides shared functionality for completion handlers and logging.
 */
export abstract class BackendProvider<TClient = unknown> {
	abstract readonly name: string;

	protected client: TClient | null = null;
	protected provider_status: ProviderStatus | null = null;

	protected readonly on_completion_progress: OnCompletionProgress;

	constructor(options: BackendProviderOptions) {
		this.on_completion_progress = options.on_completion_progress;
	}

	abstract handle_streaming_completion(
		options: CompletionHandlerOptions,
	): Promise<ActionOutputs['completion_create']>;
	abstract handle_non_streaming_completion(
		options: CompletionHandlerOptions,
	): Promise<ActionOutputs['completion_create']>;

	get_handler(streaming: boolean): CompletionHandler {
		return streaming
			? this.handle_streaming_completion.bind(this)
			: this.handle_non_streaming_completion.bind(this);
	}

	protected abstract create_client(): void;

	/** Get the client, throwing an error if not configured. */
	abstract get_client(): TClient;

	/** Get status for this provider. Override for custom availability checks. */
	abstract load_status(reload?: boolean): Promise<ProviderStatus>;

	/** Invalidate cached status, forcing next load to fetch fresh data. */
	invalidate_status(): void {
		this.provider_status = null;
	}

	/** Validates that progress_token is provided for streaming requests. */
	protected validate_streaming_requirements(progress_token?: Uuid): asserts progress_token {
		if (!progress_token) {
			throw jsonrpc_errors.invalid_params('progress_token is required for streaming');
		}
	}

	/** Sends streaming progress notification to frontend. */
	protected async send_streaming_progress(
		progress_token: Uuid,
		chunk: ActionInputs['completion_progress']['chunk'],
	): Promise<void> {
		await this.on_completion_progress({
			chunk,
			_meta: {progressToken: progress_token},
		});
	}

	/** Logs streaming chunk information. */
	protected log_streaming_chunk(chunk: unknown): void {
		console.log(`[create_completion] ${this.name} streaming chunk:`, chunk);
	}

	/** Logs streaming completion information. */
	protected log_streaming_completion(accumulated_length: number): void {
		console.log(
			`[create_completion] ${this.name} streaming completed, final content length:`,
			accumulated_length,
		);
	}

	/** Logs non-streaming response information. */
	protected log_non_streaming_response(response: unknown): void {
		console.log(`[create_completion] ${this.name} non-streaming response:`, response);
	}

	/** Logs final API response information. */
	protected log_api_response(api_response: unknown): void {
		console.log(`${this.name} api_response`, api_response);
	}
}

/**
 * Base class for remote API-based providers (Claude, ChatGPT, Gemini).
 * Handles API key management and provides default error handling for missing keys.
 */
export abstract class BackendProviderRemote<TClient = unknown> extends BackendProvider<TClient> {
	protected api_key: string | null = null;

	constructor(options: BackendProviderOptions) {
		super(options);
		this.set_api_key(options.api_key ?? null);
	}

	/** Update the API key and recreate the client. */
	set_api_key(api_key: string | null): void {
		this.api_key = api_key;
		this.provider_status = null; // Invalidate cache when API key changes
		this.create_client();
	}

	override get_client(): TClient {
		if (!this.client) {
			throw jsonrpc_errors.ai_provider_error(this.name, PROVIDER_ERROR_NEEDS_API_KEY);
		}
		return this.client;
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	override async load_status(reload = false): Promise<ProviderStatus> {
		if (!reload && this.provider_status !== null) {
			return this.provider_status;
		}

		const status: ProviderStatus = this.client
			? {name: this.name, available: true, checked_at: Date.now()}
			: {
					name: this.name,
					available: false,
					error: PROVIDER_ERROR_NEEDS_API_KEY,
					checked_at: Date.now(),
				};

		this.provider_status = status;
		return status;
	}
}

/**
 * Base class for locally-installed providers (Ollama).
 * Handles installation checking and provides default error handling for missing installations.
 */
export abstract class BackendProviderLocal<TClient = unknown> extends BackendProvider<TClient> {
	constructor(options: BackendProviderOptions) {
		super(options);
		this.create_client();
	}

	override get_client(): TClient {
		if (!this.client) {
			throw jsonrpc_errors.ai_provider_error(this.name, PROVIDER_ERROR_NOT_INSTALLED);
		}
		return this.client;
	}

	// load_status() must be implemented by subclass with installation-specific logic
}
