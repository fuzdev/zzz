// @slop Claude Sonnet 4

import type {Attachment} from 'svelte/attachments';
import {on} from 'svelte/events';

// TODO upstream to Fuz, and see the global `.scrolled` style

// TODO maybe make this more generic than just always adding a class?

export interface ScrollableParameters {
	/** CSS class to apply to the target element when scrolled. Defaults to 'scrolled'. */
	target_class?: string;
	/** Threshold in pixels before considering the element scrolled. Defaults to 0. */
	threshold?: number;
}

/**
 * Manages scroll state and provides attachments for scroll detection and styling.
 */
export class Scrollable {
	/** CSS class name to apply when scrolled. */
	target_class: string = $state.raw()!;

	/** Threshold in pixels before considering the element scrolled. */
	threshold: number = $state.raw()!;

	/** The current scroll Y position. */
	scroll_y: number = $state.raw(0);

	/** Whether element is scrolled past threshold. */
	readonly scrolled: boolean = $derived(this.scroll_y > this.threshold);

	constructor(params?: ScrollableParameters) {
		this.target_class = params?.target_class ?? 'scrolled';
		this.threshold = params?.threshold ?? 0;
	}

	// TODO maybe change the API to take params and return attachments like `reorderable` does?
	/**
	 * Attachment for the scrollable container - detects scrolling and updates state.
	 */
	container: Attachment = (element) => {
		const computed_style = window.getComputedStyle(element);

		const onscroll = () => {
			const reversed = computed_style.flexDirection === 'column-reverse';
			this.scroll_y = element.scrollTop * (reversed ? -1 : 1);
		};

		const cleanup = on(element, 'scroll', onscroll);

		onscroll();

		return () => {
			cleanup();
		};
	};

	/**
	 * Attachment for the element that should receive the scrolled class.
	 * Since attachments run in effects, the class updates will be reactive automatically.
	 */
	target: Attachment = (element) => {
		// the attachment runs in an effect, so this will re-run when scrolled changes
		if (this.scrolled) {
			element.classList.add(this.target_class);
		} else {
			element.classList.remove(this.target_class);
		}

		return () => {
			element.classList.remove(this.target_class);
		};
	};
}
