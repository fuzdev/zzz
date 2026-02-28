import type {Attachment} from 'svelte/attachments';

/**
 * Creates an attachment that calls `callback` when a mousedown occurs outside the element.
 */
export const click_outside = (callback: () => void): Attachment<HTMLElement> => {
	return (element) => {
		const handler = (e: MouseEvent) => {
			if (!element.contains(e.target as Node)) {
				callback();
			}
		};
		document.addEventListener('mousedown', handler, true);
		return () => {
			document.removeEventListener('mousedown', handler, true);
		};
	};
};
