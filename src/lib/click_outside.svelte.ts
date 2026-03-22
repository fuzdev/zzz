import type {Attachment} from 'svelte/attachments';
import {on} from 'svelte/events';

/**
 * Creates an attachment that calls `cb` when a mousedown occurs outside the element.
 */
export const click_outside =
	(cb: () => void): Attachment<HTMLElement> =>
	(element) =>
		on(
			document,
			'mousedown',
			(e) => {
				if (!element.contains(e.target as Node)) {
					cb();
				}
			},
			{capture: true},
		);
