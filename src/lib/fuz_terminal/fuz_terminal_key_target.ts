/**
 * How a page tells that a key belongs to a terminal view: the attribute the
 * view's root carries while it takes keys, and the check a page's global
 * shortcuts make. Apart from the keyboard module, so a page that only checks
 * for a terminal loads none of the key encoding.
 *
 * @module
 */

/**
 * The attribute `FuzTerminal` sets on its root while it takes keys: ready,
 * and with input on. Keyed on this, not on a styling class, so a page's own
 * shortcuts can tell (`is_fuz_terminal_key_target`).
 */
export const FUZ_TERMINAL_KEYS_ATTRIBUTE = 'data-fuz-terminal-keys';

/**
 * Whether a key event's target is inside a terminal view that takes keys —
 * for a page's global shortcuts, which must leave such a key to the terminal
 * as they leave one typed into a text field. Every key typed into the view
 * may be the program's, printable ones included.
 *
 * @param target - the event's `target`; anything that isn't an element is `false`
 */
export const is_fuz_terminal_key_target = (target: EventTarget | null): boolean => {
	const element = target as Partial<Pick<Element, 'closest'>> | null;
	return (
		typeof element?.closest === 'function' &&
		element.closest(`[${FUZ_TERMINAL_KEYS_ATTRIBUTE}]`) !== null
	);
};
