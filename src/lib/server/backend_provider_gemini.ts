import {GoogleGenerativeAI} from '@google/generative-ai';
import type * as google from '@google/generative-ai';

import {BackendProviderRemote, type CompletionHandlerOptions} from './backend_provider.js';
import {to_completion_result} from '../response_helpers.js';
import type {ActionOutputs} from '../action_collections.js';
import type {CompletionMessage} from '../completion_types.js';

export class BackendProviderGemini extends BackendProviderRemote<GoogleGenerativeAI> {
	readonly name = 'gemini';

	protected override create_client(): void {
		this.client = this.api_key ? new GoogleGenerativeAI(this.api_key) : null;
	}

	async handle_streaming_completion(
		options: CompletionHandlerOptions,
	): Promise<ActionOutputs['completion_create']> {
		const {model, completion_options, completion_messages, prompt, progress_token} = options;
		this.validate_streaming_requirements(progress_token);

		// TODO cache this by model?
		const google_model = this.get_client().getGenerativeModel(
			create_gemini_model_options(model, completion_options),
		);

		const contents = to_contents(completion_messages, prompt);

		// TODO is there a different way to use this API with the messages?
		// google_model.generateContentStream
		const stream_result = await google_model.generateContentStream({contents});

		let accumulated_content = '';
		let final_response: any = null;
		let usage_metadata: any = null;

		// Iterate over the stream
		for await (const chunk of stream_result.stream) {
			this.log_streaming_chunk(chunk);

			try {
				// Extract text from the chunk - gemini chunks have a text() method
				const chunk_text = chunk.text();
				accumulated_content += chunk_text;

				// Send streaming progress notification to frontend
				void this.send_streaming_progress(progress_token, {
					// TODO @many other chunk data
					message: {
						role: 'assistant',
						content: chunk_text,
					},
				});
			} catch (error) {
				// Text extraction might fail if prompt was blocked or other issues
				console.error('[create_completion] Failed to extract text from gemini chunk:', error);
			}

			// Store the latest response data
			final_response = chunk;
			if (chunk.usageMetadata) {
				usage_metadata = chunk.usageMetadata;
			}
		}

		this.log_streaming_completion(accumulated_content.length);

		// Create the final API response object
		const api_response = {
			text: accumulated_content,
			candidates: final_response?.candidates || null,
			function_calls: final_response?.functionCalls?.() || null,
			prompt_feedback: final_response?.promptFeedback || null,
			usage_metadata,
		};

		this.log_api_response(api_response);
		return to_completion_result('gemini', model, api_response, progress_token);
	}

	async handle_non_streaming_completion(
		options: CompletionHandlerOptions,
	): Promise<ActionOutputs['completion_create']> {
		const {model, completion_options, completion_messages, prompt} = options;

		// TODO cache this by model?
		const google_model = this.get_client().getGenerativeModel(
			create_gemini_model_options(model, completion_options),
		);

		const contents = to_contents(completion_messages, prompt);

		// TODO systemInstruction and others could also be included here, fully extend the options
		const result = await google_model.generateContent({contents});
		const response = result.response;

		this.log_non_streaming_response(response);

		const accumulated_content = response.text();

		// Create the final API response object
		const api_response = {
			text: accumulated_content,
			candidates: response.candidates || null,
			function_calls: response.functionCalls() || null,
			prompt_feedback: response.promptFeedback || null,
			usage_metadata: response.usageMetadata || null,
		};

		this.log_api_response(api_response);
		return to_completion_result('gemini', model, api_response);
	}
}

const create_gemini_model_options = (
	model: string,
	completion_options: CompletionHandlerOptions['completion_options'],
) => ({
	model,
	systemInstruction: completion_options.system_message,
	// TODO
	// tools,
	// toolConfig
	generationConfig: {
		maxOutputTokens: completion_options.output_token_max,
		temperature: completion_options.temperature,
		topK: completion_options.top_k,
		topP: completion_options.top_p,
		frequencyPenalty: completion_options.frequency_penalty,
		presencePenalty: completion_options.presence_penalty,
		stopSequences: completion_options.stop_sequences,
	},
});

// TODO @many cleanup with better data structures/helpers
const to_contents = (
	completion_messages: Array<CompletionMessage> | undefined,
	prompt: string,
): Array<google.Content> => {
	const prompt_message = {role: 'user', parts: [{text: prompt}]};

	return completion_messages
		? completion_messages
				.map(({role, content}) => ({
					role: role === 'user' ? role : 'model', // TODO maybe clearer API for mapping roles, Google uses 'model' not 'assistant'
					parts: [{text: content}],
				}))
				.concat(prompt_message)
		: [prompt_message];
};
