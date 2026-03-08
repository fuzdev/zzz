// @slop Claude Opus 4

import type {Attachment} from 'svelte/attachments';
import {on} from 'svelte/events';
import type {Flavored} from '@fuzdev/fuz_util/types.js';
import {EMPTY_OBJECT} from '@fuzdev/fuz_util/object.js';

import {
	detect_reorderable_direction,
	get_reorderable_drop_position,
	calculate_reorderable_target_index,
	is_reorder_allowed,
	validate_reorderable_target_index,
	set_reorderable_drag_data_transfer,
} from './reorderable_helpers.js';
import {create_client_id} from './helpers.js';

export type ReorderableId = Flavored<string, 'ReorderableId'>;
export type ReorderableItemId = Flavored<string, 'ReorderableItemId'>;

export type ReorderableDirection = 'horizontal' | 'vertical';

export type ReorderableDropPosition = 'none' | 'top' | 'bottom' | 'left' | 'right';

export type ReorderableValidDropPosition = Exclude<ReorderableDropPosition, 'none'>;

/**
 * Styling configuration for reorderable components.
 */
export interface ReorderableStyleOptions {
	list_class: string | null;
	item_class: string | null;
	dragging_class: string | null;
	drag_over_class: string | null;
	drag_over_top_class: string | null;
	drag_over_bottom_class: string | null;
	drag_over_left_class: string | null;
	drag_over_right_class: string | null;
	invalid_drop_class: string | null;
}

// Default CSS class names for styling
export const LIST_CLASS_DEFAULT = 'reorderable_list';
export const ITEM_CLASS_DEFAULT = 'reorderable_item';
export const DRAGGING_CLASS_DEFAULT = 'dragging';
export const DRAG_OVER_CLASS_DEFAULT = 'drag_over';
export const DRAG_OVER_TOP_CLASS_DEFAULT = 'drag_over_top';
export const DRAG_OVER_BOTTOM_CLASS_DEFAULT = 'drag_over_bottom';
export const DRAG_OVER_LEFT_CLASS_DEFAULT = 'drag_over_left';
export const DRAG_OVER_RIGHT_CLASS_DEFAULT = 'drag_over_right';
export const INVALID_DROP_CLASS_DEFAULT = 'invalid_drop';

/**
 * Parameters for list attachment.
 */
export interface ReorderableListParams {
	onreorder: (from_index: number, to_index: number) => void;
	can_reorder?: (from_index: number, to_index: number) => boolean;
	direction?: ReorderableDirection;
}

/**
 * Parameters for item attachment.
 */
export interface ReorderableItemParams {
	index: number;
}

/**
 * Additional configuration options for Reorderable.
 */
export interface ReorderableOptions {
	/**
	 * Forces a specific direction for the reorderable list.
	 * Defaults to auto-detection, `'vertical'` as the fallback.
	 */
	direction?: ReorderableDirection;
	list_class?: string | null;
	item_class?: string | null;
	dragging_class?: string | null;
	drag_over_class?: string | null;
	drag_over_top_class?: string | null;
	drag_over_bottom_class?: string | null;
	drag_over_left_class?: string | null;
	drag_over_right_class?: string | null;
	invalid_drop_class?: string | null;
}

export class Reorderable implements ReorderableStyleOptions {
	initialized = false;

	source_index = -1;
	source_item_id: ReorderableItemId | null = null;
	active_indicator_item_id: ReorderableItemId | null = null;
	current_indicator: ReorderableDropPosition = 'none';
	direction: ReorderableDirection = 'vertical';

	readonly id: ReorderableId = `r${create_client_id()}`;

	readonly list_class: string | null;
	readonly item_class: string | null;
	readonly dragging_class: string | null;
	readonly drag_over_class: string | null;
	readonly drag_over_top_class: string | null;
	readonly drag_over_bottom_class: string | null;
	readonly drag_over_left_class: string | null;
	readonly drag_over_right_class: string | null;
	readonly invalid_drop_class: string | null;

	get #drag_classes(): Array<string> {
		return [
			this.dragging_class,
			this.drag_over_class,
			this.drag_over_top_class,
			this.drag_over_bottom_class,
			this.drag_over_left_class,
			this.drag_over_right_class,
			this.invalid_drop_class,
		].filter((c): c is string => c !== null);
	}

	list_node: HTMLElement | null = null;
	list_params: ReorderableListParams | null = null;

	readonly indices: Map<ReorderableItemId, number> = new Map();
	readonly elements: Map<ReorderableItemId, HTMLElement> = new Map();

	#cleanup: (() => void) | null = null;
	#pending_init_frame: number | null = null;

	pending_items: Array<{
		id: ReorderableItemId;
		index: number;
		element: HTMLElement;
	}> = [];

	constructor(options: ReorderableOptions = EMPTY_OBJECT) {
		const {
			list_class = LIST_CLASS_DEFAULT,
			item_class = ITEM_CLASS_DEFAULT,
			dragging_class = DRAGGING_CLASS_DEFAULT,
			drag_over_class = DRAG_OVER_CLASS_DEFAULT,
			drag_over_top_class = DRAG_OVER_TOP_CLASS_DEFAULT,
			drag_over_bottom_class = DRAG_OVER_BOTTOM_CLASS_DEFAULT,
			drag_over_left_class = DRAG_OVER_LEFT_CLASS_DEFAULT,
			drag_over_right_class = DRAG_OVER_RIGHT_CLASS_DEFAULT,
			invalid_drop_class = INVALID_DROP_CLASS_DEFAULT,
			direction,
		} = options;

		this.list_class = list_class;
		this.item_class = item_class;
		this.dragging_class = dragging_class;
		this.drag_over_class = drag_over_class;
		this.drag_over_top_class = drag_over_top_class;
		this.drag_over_bottom_class = drag_over_bottom_class;
		this.drag_over_left_class = drag_over_left_class;
		this.drag_over_right_class = drag_over_right_class;
		this.invalid_drop_class = invalid_drop_class;
		if (direction) this.direction = direction;
	}

	/** Made public for testing purposes. */
	init(): void {
		if (!this.list_node || this.initialized) return;

		for (const {id, index, element} of this.pending_items) {
			this.indices.set(id, index);
			this.elements.set(id, element);
		}
		this.pending_items = [];

		this.#setup_list_events(this.list_node);
		this.initialized = true;
	}

	#reset_drag_state(): void {
		if (this.source_item_id && this.dragging_class) {
			const element = this.elements.get(this.source_item_id);
			if (element) {
				element.classList.remove(this.dragging_class);
			}
		}

		this.source_item_id = null;
		this.source_index = -1;
		this.clear_indicators();
	}

	get #is_valid_drag_operation(): boolean {
		return this.source_index !== -1 && this.source_item_id !== null;
	}

	clear_indicators(): void {
		if (!this.active_indicator_item_id) return;

		const element = this.elements.get(this.active_indicator_item_id);
		if (element) {
			element.classList.remove(...this.#drag_classes);
		}

		this.active_indicator_item_id = null;
		this.current_indicator = 'none';
	}

	update_indicator(
		item_id: ReorderableItemId,
		new_indicator: ReorderableDropPosition,
		is_valid = true,
	): void {
		if (this.source_item_id === item_id || new_indicator === 'none') {
			this.clear_indicators();
			return;
		}

		if (item_id === this.active_indicator_item_id && new_indicator === this.current_indicator) {
			return;
		}

		const element = this.elements.get(item_id);
		if (!element) return;

		this.clear_indicators();

		if (this.drag_over_class) element.classList.add(this.drag_over_class);

		if (!is_valid) {
			if (this.invalid_drop_class) element.classList.add(this.invalid_drop_class);
		} else {
			const direction_class = {
				top: this.drag_over_top_class,
				bottom: this.drag_over_bottom_class,
				left: this.drag_over_left_class,
				right: this.drag_over_right_class,
			}[new_indicator];

			if (direction_class) element.classList.add(direction_class);
		}

		this.active_indicator_item_id = item_id;
		this.current_indicator = new_indicator;
	}

	#find_item_from_event(
		event: Event,
	): [item_id: ReorderableItemId, index: number, item: HTMLElement] | null {
		const target = event.target as HTMLElement | null;
		if (!target || !this.list_node) return null;

		let current: HTMLElement | null = target;
		while (current && current !== this.list_node) {
			const item_id = current.dataset.reorderable_item_id as ReorderableItemId | undefined;
			if (item_id) {
				const index = this.indices.get(item_id);
				const element = this.elements.get(item_id);
				if (index !== undefined && element) {
					return [item_id, index, element];
				}
			}

			current = current.parentElement;
		}

		return null;
	}

	#setup_list_events(list: HTMLElement): void {
		this.#cleanup_events();

		const handlers = [
			on(
				list,
				'dragstart',
				(e: DragEvent) => {
					if (!e.dataTransfer) return;

					const found = this.#find_item_from_event(e);
					if (!found) return;

					const [item_id, index, element] = found;

					this.source_index = index;
					this.source_item_id = item_id;

					if (this.dragging_class) element.classList.add(this.dragging_class);

					set_reorderable_drag_data_transfer(e.dataTransfer, item_id);
				},
				{capture: true},
			),
			on(
				list,
				'dragend',
				() => {
					this.#reset_drag_state();
				},
				{capture: true},
			),
			on(list, 'dragover', (e: DragEvent) => {
				e.preventDefault();
				if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

				if (!this.#is_valid_drag_operation) {
					this.clear_indicators();
					return;
				}

				const found = this.#find_item_from_event(e);
				if (!found) {
					this.clear_indicators();
					return;
				}

				const [item_id, item_index] = found;

				if (this.source_item_id === item_id) {
					this.clear_indicators();
					return;
				}

				const position = get_reorderable_drop_position(
					this.direction,
					this.source_index,
					item_index,
				);

				const target_index = calculate_reorderable_target_index(
					this.source_index,
					item_index,
					position,
				);

				const allowed = is_reorder_allowed(
					this.list_params?.can_reorder,
					this.source_index,
					target_index,
				);

				this.update_indicator(item_id, position, allowed);
			}),
			on(list, 'drop', (e: DragEvent) => {
				e.preventDefault();

				if (!this.#is_valid_drag_operation) {
					this.#reset_drag_state();
					return;
				}

				const found = this.#find_item_from_event(e);
				if (!found) {
					this.#reset_drag_state();
					return;
				}

				const [item_id, item_index] = found;

				if (this.source_item_id === item_id) {
					this.#reset_drag_state();
					return;
				}

				const position = get_reorderable_drop_position(
					this.direction,
					this.source_index,
					item_index,
				);

				let target_index = calculate_reorderable_target_index(
					this.source_index,
					item_index,
					position,
				);
				target_index = validate_reorderable_target_index(target_index, this.indices.size - 1);

				if (!is_reorder_allowed(this.list_params?.can_reorder, this.source_index, target_index)) {
					this.#reset_drag_state();
					return;
				}

				const source_index = this.source_index;

				this.#reset_drag_state();

				try {
					this.list_params?.onreorder(source_index, target_index);
				} catch (error) {
					console.error('[reorderable] error during reordering:', error);
				}
			}),
			on(list, 'dragleave', (e: DragEvent) => {
				const related_target = e.relatedTarget as Node | null;
				if (!related_target || !list.contains(related_target)) {
					this.clear_indicators();
				}
			}),
			on(list, 'dragenter', (e: DragEvent) => {
				e.preventDefault();
				if (e.dataTransfer) {
					e.dataTransfer.dropEffect = 'move';
				}
			}),
		];

		this.#cleanup = () => {
			for (const cleanup of handlers) {
				cleanup();
			}
		};
	}

	#cleanup_events(): void {
		if (this.#cleanup) {
			this.#cleanup();
			this.#cleanup = null;
		}

		if (this.#pending_init_frame !== null) {
			cancelAnimationFrame(this.#pending_init_frame);
			this.#pending_init_frame = null;
		}
	}

	list = (params: ReorderableListParams): Attachment<HTMLElement> => {
		return (node) => {
			if (this.list_node && this.list_node !== node) {
				throw new Error('reorderable instance is already attached to a different list element');
			}

			if (this.list_node === node) {
				this.#cleanup_events();
				this.initialized = false;
			}

			if (params.direction) {
				this.direction = params.direction;
			} else if (!this.initialized) {
				this.direction = detect_reorderable_direction(node);
			}

			this.list_params = params;
			this.list_node = node;

			this.indices.clear();
			this.elements.clear();
			this.#reset_drag_state();

			if (this.list_class) node.classList.add(this.list_class);
			node.setAttribute('role', 'list');
			node.dataset.reorderable_list_id = this.id;

			// allows all items to register first because the order isn't always guaranteed
			this.#pending_init_frame = requestAnimationFrame(() => {
				this.#pending_init_frame = null;
				this.init();
			});

			return () => {
				this.#cleanup_events();

				if (this.list_class) node.classList.remove(this.list_class);
				node.removeAttribute('role');
				delete node.dataset.reorderable_list_id;

				this.list_node = null;
				this.list_params = null;
				this.initialized = false;
				this.pending_items = [];
				this.indices.clear();
				this.elements.clear();
				this.#reset_drag_state();
			};
		};
	};

	item = (params: ReorderableItemParams): Attachment<HTMLElement> => {
		return (node) => {
			const {index} = params;

			let item_id = node.dataset.reorderable_item_id as ReorderableItemId | undefined;
			if (!item_id) {
				item_id = `i${create_client_id()}`;
				node.dataset.reorderable_item_id = item_id;
			}
			node.setAttribute('draggable', 'true');
			const item_class = this.item_class;
			if (item_class) node.classList.add(item_class);
			node.setAttribute('role', 'listitem');
			node.dataset.reorderable_list_id = this.id;

			if (this.initialized) {
				this.indices.set(item_id, index);
				this.elements.set(item_id, node);
			} else {
				this.pending_items.push({id: item_id, index, element: node});
			}

			return () => {
				if (this.initialized) {
					this.indices.delete(item_id);
					this.elements.delete(item_id);
				} else {
					this.pending_items = this.pending_items.filter((item) => item.id !== item_id);
				}

				if (item_class) node.classList.remove(item_class);
				node.removeAttribute('role');
				node.removeAttribute('draggable');
				delete node.dataset.reorderable_list_id;
				delete node.dataset.reorderable_item_id;

				if (this.active_indicator_item_id === item_id) {
					this.active_indicator_item_id = null;
					this.current_indicator = 'none';
				}

				if (this.source_item_id === item_id) {
					this.#reset_drag_state();
				}
			};
		};
	};
}
