import OpenAI from 'openai';

import {
	BackendProviderRemote,
	type BackendProviderOptions,
	type CompletionHandlerOptions,
} from './backend_provider.js';
import {to_completion_result} from '../response_helpers.js';
import type {ActionOutputs} from '../action_collections.js';
import type {CompletionMessage} from '../completion_types.js';

export class BackendProviderChatgpt extends BackendProviderRemote<OpenAI> {
	readonly name = 'chatgpt';

	constructor(options: BackendProviderOptions) {
		super(options);
	}

	protected override create_client(): void {
		this.client = this.api_key ? new OpenAI({apiKey: this.api_key}) : null;
	}

	async handle_streaming_completion(
		options: CompletionHandlerOptions,
	): Promise<ActionOutputs['completion_create']> {
		const {model, completion_options, completion_messages, prompt, progress_token} = options;
		this.validate_streaming_requirements(progress_token);

		// TODO use responses API instead
		const stream = await this.get_client().chat.completions.create(
			create_chatgpt_completion_options(
				model,
				completion_options,
				completion_messages,
				prompt,
				true,
			),
		);

		let accumulated_content = '';
		let completion_id = '';
		let finish_reason: string | null = null;
		let final_usage: any = null;

		for await (const chunk of stream) {
			this.log_streaming_chunk(chunk);

			// Get ID from first chunk
			if (!completion_id && chunk.id) {
				completion_id = chunk.id;
			}

			// Extract content from choices
			const delta = chunk.choices[0]?.delta;
			// TODO temporary bug: https://github.com/typescript-eslint/typescript-eslint/issues/11666
			if (delta?.content) {
				accumulated_content += delta.content;

				// Send streaming progress notification to frontend
				void this.send_streaming_progress(progress_token, {
					// TODO @many other chunk data
					message: {
						role: 'assistant',
						content: delta.content,
					},
				});
			}

			// Capture finish reason
			if (chunk.choices[0]?.finish_reason) {
				finish_reason = chunk.choices[0].finish_reason;
			}

			// Capture usage data
			if (chunk.usage) {
				final_usage = chunk.usage;
			}
		}

		this.log_streaming_completion(accumulated_content.length);

		// Create the final API response object
		const api_response = {
			id: completion_id,
			object: 'chat.completion',
			created: Date.now() / 1000,
			model,
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant', // TODO @api @many hardcoded role, which of these are correct if any?
						content: accumulated_content,
					},
					finish_reason: finish_reason || 'stop',
				},
			],
			usage: final_usage,
		};

		this.log_api_response(api_response);
		return to_completion_result('chatgpt', model, api_response, progress_token);
	}

	async handle_non_streaming_completion(
		options: CompletionHandlerOptions,
	): Promise<ActionOutputs['completion_create']> {
		const {model, completion_options, completion_messages, prompt} = options;

		// TODO use responses API instead
		const response = await this.get_client().chat.completions.create(
			create_chatgpt_completion_options(
				model,
				completion_options,
				completion_messages,
				prompt,
				false,
			),
		);

		this.log_non_streaming_response(response);

		const api_response = {
			id: response.id,
			object: response.object,
			created: response.created,
			model: response.model,
			choices: response.choices,
			usage: response.usage,
		};

		this.log_api_response(api_response);
		return to_completion_result('chatgpt', model, api_response);
	}
}

const create_chatgpt_completion_options = <T extends boolean>(
	model: string,
	completion_options: CompletionHandlerOptions['completion_options'],
	completion_messages: Array<CompletionMessage> | undefined,
	prompt: string,
	stream: T,
) => ({
	model,
	stream,
	max_completion_tokens: completion_options.output_token_max,
	temperature: completion_options.temperature,
	seed: completion_options.seed,
	top_p: completion_options.top_p,
	frequency_penalty: completion_options.frequency_penalty,
	presence_penalty: completion_options.presence_penalty,
	stop: completion_options.stop_sequences,
	messages: to_messages(completion_options.system_message, completion_messages, prompt, model),
});

// TODO @many cleanup with better data structures/helpers
const to_messages = (
	system_message: string,
	completion_messages: Array<CompletionMessage> | undefined,
	prompt: string,
	model: string,
): Array<{role: 'system' | 'user' | 'assistant'; content: string}> => {
	const openai_messages: Array<{role: 'system' | 'user' | 'assistant'; content: string}> = [];

	// Only add system message if the model supports it
	if (model !== 'o1-mini') {
		openai_messages.push({
			role: 'system',
			content: system_message,
		});
	}

	// Add thread history
	if (completion_messages) {
		for (const message of completion_messages) {
			openai_messages.push({
				role: message.role as 'system' | 'user' | 'assistant', // TODO maybe parse?
				content: message.content,
			});
		}
	}

	// Add the current message
	openai_messages.push({
		role: 'user',
		content: prompt,
	});

	return openai_messages;
};
