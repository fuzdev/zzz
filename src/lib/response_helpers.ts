import type { ActionOutputs } from './action_collections.ts';

// TODO hacky, shouldn't exist
/**
 * Extracts the text content from a completion response.
 */
export const to_completion_response_text = (
	completion_response: ActionOutputs['completion_create']['completion_response'] | null | undefined
): string | null => {
	if (!completion_response) return null;

	const { data } = completion_response;

	switch (data.type) {
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
