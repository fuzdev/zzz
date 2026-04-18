import {Ollama} from 'ollama';
import {find_cli} from '@fuzdev/gro/cli.js';

import {BackendProviderLocal, type CompletionHandlerOptions} from './backend_provider.js';
import {to_completion_result} from '../response_helpers.js';
import {ActionInputs, type ActionOutputs} from '../action_collections.js';
import type {CompletionMessage} from '../completion_types.js';
import {type ProviderStatus, PROVIDER_ERROR_NOT_INSTALLED} from '../provider_types.js';

export class BackendProviderOllama extends BackendProviderLocal<Ollama> {
	readonly name = 'ollama';

	protected override create_client(): void {
		// {fetch, headers, host, proxy}
		this.client = new Ollama();
	}

	override async load_status(reload: boolean = false): Promise<ProviderStatus> {
		// Return cached status if available and reload not requested
		if (!reload && this.provider_status !== null) {
			return this.provider_status;
		}

		// Check if ollama CLI is installed
		if (!(await find_cli('ollama'))) {
			const status: ProviderStatus = {
				name: this.name,
				available: false,
				error: PROVIDER_ERROR_NOT_INSTALLED,
				checked_at: Date.now(),
			};
			this.provider_status = status;
			return status;
		}

		try {
			await this.get_client().list();
			const status: ProviderStatus = {
				name: this.name,
				available: true,
				checked_at: Date.now(),
			};
			this.provider_status = status;
			return status;
		} catch (error) {
			console.error('[BackendProviderOllama] error checking availability:', error);
			const error_message = error instanceof Error ? error.message : String(error);
			const status: ProviderStatus = {
				name: this.name,
				available: false,
				error: error_message,
				checked_at: Date.now(),
			};
			this.provider_status = status;
			return status;
		}
	}

	/** Ensure the model is available locally, pulling if needed. */
	async #ensure_model(model: string): Promise<void> {
		// TODO @many is this what we want to do? or error? needs to stream progress in the streaming case
		const listed = await this.get_client().list();
		if (!listed.models.some((m) => m.name === model)) {
			await this.get_client().pull({model}); // TODO handle stream
		}
	}

	async handle_streaming_completion(
		options: CompletionHandlerOptions,
	): Promise<ActionOutputs['completion_create']> {
		const {model, completion_options, completion_messages, prompt, progress_token, on_progress} =
			options;
		this.validate_streaming_requirements(progress_token);

		await this.#ensure_model(model);

		// TODO should we support generate({prompt})?
		const response = await this.get_client().chat(
			create_ollama_chat_options(model, completion_options, completion_messages, prompt, true),
		);

		let accumulated_content = '';
		let final_response;

		for await (const chunk of response) {
			this.log_streaming_chunk(chunk);

			// Accumulate the message content
			accumulated_content += chunk.message.content;

			// Send streaming progress notification to frontend
			void this.send_streaming_progress(
				progress_token,
				// TODO see the other patterns, maybe the API should be parsing and this takes the input schema (same issue on frontend)
				ActionInputs.completion_progress.shape.chunk.parse(chunk),
				on_progress,
			);

			// Store the final response data
			final_response = chunk;
		}

		this.log_streaming_completion(accumulated_content.length);

		// Create the final API response object
		const api_response = {
			...final_response, // TODO is this right?
			message: {
				...final_response?.message, // TODO is this right?
				content: accumulated_content,
			},
		};

		this.log_api_response(api_response);
		return to_completion_result('ollama', model, api_response, progress_token);
	}

	async handle_non_streaming_completion(
		options: CompletionHandlerOptions,
	): Promise<ActionOutputs['completion_create']> {
		const {model, completion_options, completion_messages, prompt} = options;

		await this.#ensure_model(model);

		const response = await this.get_client().chat(
			create_ollama_chat_options(model, completion_options, completion_messages, prompt, false),
		);

		this.log_non_streaming_response(response);

		const api_response = {
			...response,
			message: {
				...response.message,
				content: response.message.content,
			},
		};

		this.log_api_response(api_response);
		return to_completion_result('ollama', model, api_response);
	}
}

const create_ollama_chat_options = <T extends boolean>(
	model: string,
	completion_options: CompletionHandlerOptions['completion_options'],
	completion_messages: Array<CompletionMessage> | undefined,
	prompt: string,
	stream: T,
) => ({
	model,
	// TODO
	// format,
	// keep_alive,
	stream,
	// think,
	// tools,
	options: {
		temperature: completion_options.temperature,
		seed: completion_options.seed,
		num_predict: completion_options.output_token_max,
		top_k: completion_options.top_k,
		top_p: completion_options.top_p,
		frequency_penalty: completion_options.frequency_penalty,
		presence_penalty: completion_options.presence_penalty,
		stop: completion_options.stop_sequences,
	},
	messages: to_messages(completion_options.system_message, completion_messages, prompt),
});

const to_messages = (
	system_message: string,
	completion_messages: Array<CompletionMessage> | undefined,
	prompt: string,
): Array<{role: string; content: string}> => {
	return [
		{role: 'system', content: system_message},
		...(completion_messages || []),
		{role: 'user', content: prompt},
	];
};
