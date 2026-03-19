import {get_datetime_now, Uuid} from './zod_helpers.js';
import type {ActionOutputs} from './action_collections.js';
import type {ProviderName, ProviderData} from './provider_types.js';
import type {ModelName} from './model.svelte.js';

// TODO refactor these

// TODO hacky, shouldn't exist
/**
 * Extracts the text content from a completion response.
 */
export const to_completion_response_text = (
	completion_response: ActionOutputs['completion_create']['completion_response'] | null | undefined,
): string | null => {
	if (!completion_response) return null;

	const {data} = completion_response;

	switch (data.type) {
		case 'ollama':
			return data.value?.message?.content || null;
		case 'claude':
			return data.value?.content?.[0]?.text || null;
		case 'chatgpt':
			return data.value?.choices?.[0]?.message?.content || null;
		case 'gemini':
			return data.value.text || null;
		default:
			console.error('unknown provider type', data);
			return null;
	}
};

// TODO hacky, probably refactor
/**
 * Creates a standardized `CompletionResponse` message from provider-specific responses.
 */
export const to_completion_result = (
	provider_name: ProviderName,
	model: ModelName,
	api_response: unknown, // TODO types
	progress_token?: Uuid,
): ActionOutputs['completion_create'] => {
	let provider_data: ProviderData;

	// Convert provider-specific response format to our standard format
	switch (provider_name) {
		case 'ollama':
			provider_data = {
				type: 'ollama',
				value: api_response,
			};
			break;
		case 'claude':
			provider_data = {
				type: 'claude',
				value: api_response,
			};
			break;
		case 'chatgpt':
			provider_data = {
				type: 'chatgpt',
				value: api_response,
			};
			break;
		case 'gemini':
			provider_data = {
				type: 'gemini',
				value: {
					// TODO hacky
					text: (api_response as any)?.text || (api_response as any)?.response?.text() || '',
					candidates: (api_response as any)?.candidates || null,
					function_calls: (api_response as any)?.function_calls || null,
					prompt_feedback: (api_response as any)?.prompt_feedback || null,
					usage_metadata: (api_response as any)?.usage_metadata || null,
				},
			};
			break;
		default:
			// TODO throw jsonrpc error
			throw new Error(`unsupported provider: ${provider_name}`);
	}

	const created = get_datetime_now();

	const output: ActionOutputs['completion_create'] = {
		completion_response: {
			created,
			provider_name,
			model,
			data: provider_data,
		},
	};

	if (progress_token) {
		output._meta = {progressToken: progress_token};
	}

	return output;
};
