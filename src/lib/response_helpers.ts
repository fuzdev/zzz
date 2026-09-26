import type { CompletionResponse } from './completion_types.ts';

/**
 * Why a reply was cut off: the output token limit, or (Claude only) the
 * context window.
 */
export type CompletionTruncation = 'max_tokens' | 'context_window';

/**
 * The stop/finish reasons, per provider, that mean a reply was cut off rather
 * than finished, and which limit cut it off.
 */
const TRUNCATION_STOP_REASONS: Record<
	CompletionResponse['data']['type'],
	Partial<Record<string, CompletionTruncation>>
> = {
	claude: { max_tokens: 'max_tokens', model_context_window_exceeded: 'context_window' },
	chatgpt: { length: 'max_tokens' },
	gemini: { MAX_TOKENS: 'max_tokens' }
};

// TODO hacky, shouldn't exist
/**
 * Extracts the text content from a completion response.
 * For Claude, joins every `text` content block, skipping `thinking` blocks.
 */
export const to_completion_response_text = (
	completion_response: CompletionResponse | null | undefined
): string | null => {
	if (!completion_response) return null;

	const { data } = completion_response;

	switch (data.type) {
		case 'claude': {
			const content: unknown = data.value?.content;
			if (!Array.isArray(content)) return null;
			let text = '';
			for (const block of content) {
				// a block without a `type` is treated as text
				if (block?.type !== undefined && block.type !== 'text') continue;
				if (typeof block?.text === 'string') text += block.text;
			}
			return text || null;
		}
		case 'chatgpt':
			return data.value?.choices?.[0]?.message?.content || null;
		case 'gemini':
			return data.value.text || null;
		default:
			console.error('unknown provider type', data);
			return null;
	}
};

/**
 * Reads the provider's own stop/finish reason from a completion response —
 * Claude's `stop_reason`, ChatGPT's `finish_reason`, Gemini's `finishReason`.
 *
 * @returns the reason, or `null` when the response carries none
 */
export const to_completion_stop_reason = (
	completion_response: CompletionResponse | null | undefined
): string | null => {
	if (!completion_response) return null;

	const { data } = completion_response;

	let reason: unknown;
	switch (data.type) {
		case 'claude':
			reason = data.value?.stop_reason;
			break;
		case 'chatgpt':
			reason = data.value?.choices?.[0]?.finish_reason;
			break;
		case 'gemini':
			reason = data.value.candidates?.[0]?.finishReason;
			break;
	}
	return typeof reason === 'string' ? reason : null;
};

/**
 * Why a completion response was cut off rather than finished. The backend fails
 * a cut-off reply with no text, so a truncated response always has some.
 *
 * @returns the limit that cut the reply off, or `null` when it finished
 */
export const to_completion_truncation = (
	completion_response: CompletionResponse | null | undefined
): CompletionTruncation | null => {
	const reason = to_completion_stop_reason(completion_response);
	if (reason === null || !completion_response) return null;
	const reasons = TRUNCATION_STOP_REASONS[completion_response.data.type];
	return Object.hasOwn(reasons, reason) ? (reasons[reason] ?? null) : null;
};

/**
 * Whether a completion response was cut off by the output token limit or the
 * context window rather than finished.
 */
export const is_completion_truncated = (
	completion_response: CompletionResponse | null | undefined
): boolean => to_completion_truncation(completion_response) !== null;
