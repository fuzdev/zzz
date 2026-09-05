import type { Turn } from './turn.svelte.ts';
import type { CompletionMessage, CompletionRole } from './completion_types.ts';
import { to_completion_response_text } from './response_helpers.ts';

// TODO refactor where?
/**
 * Renders a single message with an XML tag that includes the role attribute.
 */
export const render_message_with_role = (
	role: CompletionRole,
	content: string,
	tag = 'message'
): string => `<${tag} role="${role}">${content}</${tag}>`;

export const render_messages_to_string = (
	turns: Iterable<{ role: CompletionRole; content: string; enabled?: boolean }>,
	tag = 'message'
): string => {
	let s = '';

	for (const turn of turns) {
		if (turn.enabled === false) continue;

		if (s) s += '\n\n';
		s += render_message_with_role(turn.role, turn.content, tag);
	}

	return s;
};

/**
 * Creates a thread history array for model consumption from a collection of turns.
 * Normalizes content for assistant turns with responses.
 */
export const render_completion_messages = (
	turns: Iterable<Turn>,
	completion_messages: Array<CompletionMessage> = []
): Array<CompletionMessage> => {
	for (const turn of turns) {
		if (!turn.enabled) continue;

		completion_messages.push({
			role: turn.role,
			content:
				turn.role === 'assistant' && turn.response
					? to_completion_response_text(turn.response) || ''
					: turn.content
		});
	}

	return completion_messages;
};
