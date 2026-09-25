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
 *
 * Skips disabled turns, errored turns (their partial content isn't a valid reply),
 * and turns with empty or whitespace-only content (e.g. a completion cancelled
 * before the first token), because providers like Anthropic reject empty messages.
 * Cancelled turns with partial content are kept.
 *
 * @param turns - the thread's turns in order
 * @param completion_messages - array to append to
 * @returns `completion_messages` with the rendered turns appended
 * @mutates completion_messages - appends one message per included turn
 */
export const render_completion_messages = (
	turns: Iterable<Pick<Turn, 'enabled' | 'role' | 'content' | 'response' | 'error_message'>>,
	completion_messages: Array<CompletionMessage> = []
): Array<CompletionMessage> => {
	for (const turn of turns) {
		// TODO excluding an errored turn can leave consecutive same-role messages (the user
		// turn before it, then the next user turn) — if a provider rejects that, merge
		// adjacent same-role messages server-side in the providers' `build_*` request builders
		if (!turn.enabled || turn.error_message) continue;

		const content =
			turn.role === 'assistant' && turn.response
				? to_completion_response_text(turn.response) || ''
				: turn.content;
		if (!content.trim()) continue;

		completion_messages.push({ role: turn.role, content });
	}

	return completion_messages;
};
