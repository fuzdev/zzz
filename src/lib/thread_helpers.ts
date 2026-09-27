import type { Turn } from './turn.svelte.ts';
import type { CompletionMessage, CompletionRole } from './completion_types.ts';

// TODO refactor where?
/**
 * Renders a single message with an XML tag that includes the role attribute.
 */
export const render_message_with_role = (
	role: CompletionRole,
	content: string,
	tag = 'message'
): string => `<${tag} role="${role}">${content}</${tag}>`;

/**
 * The length of `render_message_with_role(role, content, tag)` for a content of
 * `content_length` characters, without building the string.
 */
export const render_message_with_role_length = (
	role: CompletionRole,
	content_length: number,
	tag = 'message'
): number => render_message_with_role(role, '', tag).length + content_length;

/**
 * The length of `render_messages_to_string(turns, tag)`, from each turn's
 * content `length` rather than its content — so a streaming reply updates the
 * total without re-concatenating the whole thread.
 */
export const render_messages_length = (
	turns: Iterable<{ role: CompletionRole; length: number; enabled?: boolean }>,
	tag = 'message'
): number => {
	let length = 0;
	let first = true;
	for (const turn of turns) {
		if (turn.enabled === false) continue;
		if (first) first = false;
		else length += 2; // the '\n\n' separator
		length += render_message_with_role_length(turn.role, turn.length, tag);
	}
	return length;
};

/**
 * The length of contents joined with `'\n\n'`, skipping null ones, as a turn
 * joins its parts' content — from the contents' lengths, without building the string.
 */
export const joined_content_length = (
	content_lengths: Iterable<number | null | undefined>
): number => {
	let length = 0;
	let count = 0;
	for (const content_length of content_lengths) {
		if (content_length == null) continue;
		length += content_length;
		count++;
	}
	return count > 1 ? length + 2 * (count - 1) : length;
};

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
 *
 * Every turn contributes its current `content`, so edits to a completed
 * assistant turn are what later requests see. Skips disabled turns, errored
 * turns (their partial content isn't a valid reply), and turns with empty or
 * whitespace-only content (e.g. a completion cancelled before the first token),
 * because providers like Anthropic reject empty messages. Cancelled turns with
 * partial content are kept. Assistant turns before the first user turn are
 * dropped (e.g. when the first user turn is disabled or removed), since
 * Anthropic and Gemini require the conversation to open with a user message;
 * `system` turns are kept wherever they are.
 *
 * @param turns - the thread's turns in order
 * @param completion_messages - array to append to
 * @returns `completion_messages` with the rendered turns appended
 * @mutates completion_messages - appends one message per included turn
 */
export const render_completion_messages = (
	turns: Iterable<Pick<Turn, 'enabled' | 'role' | 'content' | 'error_message'>>,
	completion_messages: Array<CompletionMessage> = []
): Array<CompletionMessage> => {
	let seen_user = completion_messages.some((m) => m.role === 'user');
	for (const turn of turns) {
		// excluding an errored turn can leave consecutive same-role messages (the user turn
		// before it, then the next user turn) — the Gemini request builder merges adjacent
		// same-role messages server-side; Anthropic and OpenAI accept them as-is
		if (!turn.enabled || turn.error_message) continue;

		const { role, content } = turn;
		if (!content.trim()) continue;

		if (role === 'user') {
			seen_user = true;
		} else if (role !== 'system' && !seen_user) {
			continue;
		}

		completion_messages.push({ role, content });
	}

	return completion_messages;
};
