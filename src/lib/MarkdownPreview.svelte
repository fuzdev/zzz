<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';
	import { DEV } from 'esm-env';
	import Mdz from '@fuzdev/mdz/Mdz.svelte';
	import { mdz_parse, type MdzNode } from '@fuzdev/mdz/mdz.ts';

	import { frontend_context } from './frontend.svelte.ts';
	import {
		resolve_markdown_link,
		to_directory_readme_path,
		to_markdown_link_mark,
		to_markdown_link_status,
		to_markdown_link_title,
		to_markdown_links,
		query_markdown_link_anchors,
		find_markdown_link_index,
		type MarkdownLink
	} from './markdown_links.ts';
	import {
		find_markdown_caret_block,
		query_markdown_blocks,
		read_mdz_source_range,
		to_markdown_leaf_blocks,
		to_markdown_scroll_anchors,
		type MarkdownBlock,
		type MarkdownScrollAnchor
	} from './markdown_source_map.ts';

	/**
	 * Rendered markdown, read-only — a file's content, or any markdown
	 * string. Scrolls on its own, so it can sit beside an editor; it takes
	 * focus like an editor does (`focus_key`), so arrow keys scroll it.
	 *
	 * Its links never navigate the app. An external link opens in a new tab,
	 * an in-document `#fragment` scrolls the preview, and — given the file's
	 * `path` — a relative link opens the indexed file it names in a tab (see
	 * `markdown_links.ts`), a preview tab on a plain click and a kept tab on a
	 * middle- or Ctrl/Cmd-click; a link to a folder opens its README. Links
	 * the file index says are missing are marked broken, and ones it can't
	 * see marked unknown, each with a title saying why. Anything else —
	 * without a `path`, any relative link — does nothing.
	 *
	 * mdz renders with its source offsets (`source_offsets`), which pair each
	 * link with its anchor and, beside an editor, map the preview back to the
	 * source: the block holding the editor's caret is marked
	 * (`caret_offset`), a click on a block reports where its source starts
	 * (`onsourceclick`), and scroll sync reads the blocks
	 * (`get_scroll_anchors`, see `markdown_scroll_sync.ts`), as does an
	 * outline's highlight (`get_leaf_blocks`, `get_heading_elements`). The
	 * offsets index the string parsed, `content` or the one `nodes` came from.
	 *
	 * @module
	 */

	// TODO highlighted codeblocks plug in here, as an mdz codeblock context set around `Mdz` - its
	// component must spread the offset props (`MdzSourceOffsetProps`) onto its root, or the caret
	// mark, click-to-source, and scroll sync lose the block
	// TODO the repos reader renders files at a revision, which needs its own index and opener -
	// maybe a prop taking a `MarkdownLinkIndex` and an `onopen`

	let {
		content,
		nodes,
		links: links_prop,
		path,
		focus_key,
		pending_element_to_focus_key = $bindable(),
		caret_offset = null,
		onsourceclick,
		attrs
	}: {
		/** The absolute path of the file rendered — without it, relative links are inert. */
		path?: string | null | undefined;
		/** Focuses the preview when `pending_element_to_focus_key` equals it, then clears that. */
		focus_key?: string | number | null | undefined;
		pending_element_to_focus_key?: string | number | null | undefined;
		/**
		 * The caret of an editor over the same source, an offset into the parsed
		 * string — marks the innermost block holding it (`find_markdown_caret_block`).
		 */
		caret_offset?: number | null | undefined;
		/**
		 * Called on a plain click on rendered content — not a link, a control, a
		 * multi-click, the end of a selection drag, or a touch tap — with the
		 * source offset where the innermost element under it starts. Without it,
		 * a click only focuses the preview.
		 */
		onsourceclick?: ((offset: number) => void) | undefined;
		/** Attributes for the scroll container. */
		attrs?: SvelteHTMLElements['div'] | undefined;
	} & (
		| {
				/** The markdown source to render. */
				content: string;
				nodes?: undefined;
				links?: undefined;
		  }
		| {
				content?: undefined;
				/** The markdown, already parsed by `mdz_parse` — to share one parse with an outline. */
				nodes: Array<MdzNode>;
				/**
				 * The links of `nodes`, from `to_markdown_links` with this `path` and the app's
				 * `link_index` — to share one list with a link list, so its indexes are the preview's.
				 */
				links?: ReadonlyArray<MarkdownLink> | undefined;
		  }
	) = $props();

	const app = frontend_context.get_maybe();

	const parsed: Array<MdzNode> = $derived(nodes ?? mdz_parse(content ?? ''));

	// how far the parse reaches - where offsets from the DOM are clamped to (`read_mdz_source_range`)
	const source_length = $derived(parsed.at(-1)?.end ?? 0);

	// a file in the app's index - links resolve and are checked only then
	const index = $derived(path && app ? app.diskfiles.link_index : null);

	const links: ReadonlyArray<MarkdownLink> = $derived(
		links_prop ?? to_markdown_links(parsed, { file_path: path, index })
	);

	let container_el: HTMLDivElement | undefined = $state.raw();

	const CARET_BLOCK_CLASS = 'markdown-caret-block';

	const HEADING_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

	// a click on these acts on its own, so it never jumps to the source
	const SOURCE_CLICK_IGNORED_SELECTOR =
		'a[href], button, input, select, textarea, label, summary, [contenteditable]';

	// the titles the marking set, by anchor - mdz sets none, but only these are ours to remove
	const titles_set: WeakMap<HTMLAnchorElement, string> = new WeakMap();

	// marks each link as it stands against the index, after the render - mdz renders the anchors,
	// with no hook for attributes, and patches them in place by position, so every pass revisits
	// every anchor: a mark left from an earlier pass would sit on whatever link is there now
	$effect(() => {
		const container = container_el;
		if (!container) return;
		const anchors = query_markdown_link_anchors(container, links);
		if (DEV && anchors.includes(null)) {
			console.warn('[MarkdownPreview] a link has no rendered anchor - are `links` from `nodes`?');
		}
		const wanted: WeakMap<HTMLAnchorElement, { mark: string | null; title: string | null }> =
			new WeakMap();
		for (let i = 0; i < links.length; i++) {
			const anchor = anchors[i];
			if (!anchor) continue;
			const link = links[i]!;
			const readme_path =
				link.status === 'directory' && index && link.target.kind === 'path'
					? to_directory_readme_path(link.target.path, index)
					: null;
			wanted.set(anchor, {
				mark: to_markdown_link_mark(link.status),
				title: to_markdown_link_title(link, readme_path)
			});
		}
		for (const anchor of container.querySelectorAll('a')) {
			const { mark = null, title = null } = wanted.get(anchor) ?? {};
			// compared first, so an unchanged anchor isn't written
			if ((anchor.dataset.linkStatus ?? null) !== mark) {
				if (mark) {
					anchor.dataset.linkStatus = mark;
				} else {
					delete anchor.dataset.linkStatus;
				}
			}
			const own_title = titles_set.get(anchor);
			if (title) {
				if (anchor.getAttribute('title') !== title) anchor.setAttribute('title', title);
				titles_set.set(anchor, title);
			} else if (own_title !== undefined) {
				if (anchor.getAttribute('title') === own_title) anchor.removeAttribute('title');
				titles_set.delete(anchor);
			}
		}
	});

	// the rendered blocks, queried once per render - the caret mark, scroll sync, and an outline
	// read these, so a caret move or a scroll never queries the preview
	let blocks: Array<MarkdownBlock> = $state.raw([]);
	const scroll_anchors: Array<MarkdownScrollAnchor> = $derived(to_markdown_scroll_anchors(blocks));
	const leaf_blocks: Array<MarkdownBlock> = $derived(to_markdown_leaf_blocks(blocks));
	const heading_elements: Array<Element> = $derived(
		blocks.filter((block) => HEADING_TAGS.has(block.element.localName)).map((b) => b.element)
	);

	$effect(() => {
		const container = container_el;
		// after each render (reading `parsed`) - mdz patches its elements in place, offsets included
		blocks = container && parsed.length > 0 ? query_markdown_blocks(container, source_length) : [];
	});

	// the block marked as holding the caret - a class on an element mdz owns, which it never sets
	// a class on, so a render patching the element keeps the mark
	let caret_block_el: Element | null = null;

	$effect(() => {
		const i = caret_offset == null ? -1 : find_markdown_caret_block(blocks, caret_offset);
		const next = i === -1 ? null : blocks[i]!.element;
		if (caret_block_el !== next) caret_block_el?.classList.remove(CARET_BLOCK_CLASS);
		next?.classList.add(CARET_BLOCK_CLASS);
		caret_block_el = next;
	});

	/** The scroll-sync anchors of the current render - exposed for parent components. */
	export const get_scroll_anchors = (): ReadonlyArray<MarkdownScrollAnchor> => scroll_anchors;

	/**
	 * The leaf blocks of the current render (`to_markdown_leaf_blocks`), in
	 * source order down the preview - exposed for parent components.
	 */
	export const get_leaf_blocks = (): ReadonlyArray<MarkdownBlock> => leaf_blocks;

	/**
	 * The heading elements of the current render, in `to_markdown_headings`
	 * order - exposed for parent components.
	 */
	export const get_heading_elements = (): ReadonlyArray<Element> => heading_elements;

	/** The scroll container - exposed for parent components. */
	export const get_scroll_element = (): HTMLDivElement | undefined => container_el;

	/**
	 * Scroll the preview to its `index`th heading (`to_markdown_headings`
	 * order) - exposed for parent components.
	 *
	 * @returns whether there was one
	 */
	export const reveal_heading = (index: number): boolean => {
		const heading = container_el?.querySelectorAll('h1, h2, h3, h4, h5, h6')[index];
		if (!heading) return false;
		heading.scrollIntoView?.({ block: 'start' });
		return true;
	};

	/**
	 * Scroll the preview to its `index`th link (`to_markdown_links` order),
	 * focusing it unless `options.focus` is `false` - exposed for parent
	 * components.
	 *
	 * @returns whether it's rendered
	 */
	export const reveal_link = (index: number, options?: { focus?: boolean }): boolean => {
		if (!container_el) return false;
		const anchor = query_markdown_link_anchors(container_el, links)[index];
		if (!anchor) return false;
		anchor.scrollIntoView?.({ block: 'center' });
		if (options?.focus !== false) anchor.focus({ preventScroll: true });
		return true;
	};

	const scroll_to_fragment = (container: HTMLElement, fragment: string): void => {
		for (const el of container.querySelectorAll('[id]')) {
			if (el.id === fragment) {
				el.scrollIntoView?.();
				break;
			}
		}
	};

	/**
	 * Keeps the preview's links from navigating the app (see the module
	 * comment), for a primary click (`click`) and a middle click (`auxclick`)
	 * alike, modifiers included.
	 */
	const handle_link_event = (event: MouseEvent): void => {
		if (event.defaultPrevented) return;
		const aux = event.type === 'auxclick';
		if (event.button !== (aux ? 1 : 0)) return;
		const container = event.currentTarget;
		if (!(container instanceof HTMLElement) || !(event.target instanceof Element)) return;
		const anchor = event.target.closest('a[href]');
		if (!(anchor instanceof HTMLAnchorElement) || !container.contains(anchor)) return;

		// the link's own target, resolved from its reference - the rendered `href` can differ
		// (see `query_markdown_link_anchors`)
		const link_index = find_markdown_link_index(anchor, links);
		// an anchor the links don't account for is followed only when it's external
		const target =
			link_index === -1
				? resolve_markdown_link(anchor.getAttribute('href') ?? '')
				: links[link_index]!.target;
		if (link_index === -1 && target.kind !== 'external') {
			event.preventDefault();
			return;
		}

		if (target.kind === 'external') {
			// a link back into this app would leave the page it's on, so it's inert
			let origin: string | null = null;
			try {
				origin = new URL(target.href).origin;
			} catch {
				// unparseable, so not followed
			}
			if (origin === null || origin === location.origin) {
				event.preventDefault();
				return;
			}
			// the browser opens a new tab for a middle click, and for mdz's `target="_blank"`
			if (aux || anchor.target === '_blank') return;
			event.preventDefault();
			if (!(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) {
				window.open(target.href, '_blank', 'noopener');
			}
			return;
		}

		event.preventDefault();

		if (target.kind === 'fragment') {
			if (!aux) scroll_to_fragment(container, target.fragment);
			return;
		}

		if (target.kind !== 'path' || !index || !app) return;
		// the in-zzz twin of a new browser tab is a kept tab rather than the preview tab
		const options = {
			fragment: target.fragment,
			open_not_preview: aux || event.ctrlKey || event.metaKey
		};
		const status = to_markdown_link_status(target, index);
		if (status === 'file') {
			app.diskfiles.open_path(target.path, options);
		} else if (status === 'directory') {
			const readme_path = to_directory_readme_path(target.path, index);
			if (readme_path) app.diskfiles.open_path(readme_path, options);
		}
	};

	// the `pointerType` of the last `pointerdown`, for a click some browsers send as a plain
	// `MouseEvent` without one - read and cleared by the click; a press with no click (a
	// touch that scrolled) stays until the next click, which at worst skips one jump
	let pressed_pointer_type: string | null = null;

	/** Reports a click's source, unless it's a link's, a control's, a selection's, or a tap's. */
	const handle_source_click = (event: MouseEvent): void => {
		// the click's own type is the browser's word when it has one, `''` for no pointer -
		// the press's can be stale, left by a touch that scrolled rather than clicked
		const pointer_type = event instanceof PointerEvent ? event.pointerType : pressed_pointer_type;
		pressed_pointer_type = null;
		if (!onsourceclick || event.defaultPrevented || event.button !== 0) return;
		// a tap is for reading - a jump to the source focuses an editor, opening the on-screen
		// keyboard; a pen's tap reports, pointing as precisely as a mouse
		if (pointer_type === 'touch') return;
		// a multi-click selects a word or a line, and a modified click extends a selection
		if (event.detail > 1 || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}
		const container = event.currentTarget;
		if (!(container instanceof HTMLElement) || !(event.target instanceof Element)) return;
		if (event.target.closest(SOURCE_CLICK_IGNORED_SELECTOR)) return;
		// a drag that selected text ends in a click - leave the selection to be copied
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed && container.contains(selection.anchorNode)) return;
		const el = event.target.closest('[data-mdz-start][data-mdz-end]');
		if (!el || !container.contains(el)) return;
		const range = read_mdz_source_range(el, source_length);
		if (range) onsourceclick(range.start);
	};
</script>

<div
	tabindex="-1"
	{...attrs}
	class={['markdown-preview overflow:auto', attrs?.class]}
	onclick={(event) => {
		attrs?.onclick?.(event);
		handle_link_event(event);
		handle_source_click(event);
	}}
	onauxclick={(event) => {
		attrs?.onauxclick?.(event);
		handle_link_event(event);
	}}
	onpointerdown={(event) => {
		attrs?.onpointerdown?.(event);
		pressed_pointer_type = event.pointerType;
	}}
	{@attach (el: HTMLDivElement) => {
		container_el = el;
		return () => {
			container_el = undefined;
		};
	}}
	{@attach focus_key == null
		? null
		: (el: HTMLDivElement) => {
				if (focus_key === pending_element_to_focus_key) {
					pending_element_to_focus_key = null;
					el.focus();
				}
			}}
>
	<div class="width_atmost_md p_lg">
		{#if parsed.length === 0}
			<p class="text_50">nothing to preview</p>
		{:else}
			<Mdz nodes={parsed} source_offsets />
		{/if}
	</div>
</div>

<style>
	/* subtle: the text stays a link's, only its underline says how it stands */
	.markdown-preview :global(a[data-link-status='broken']) {
		text-decoration-line: underline;
		text-decoration-style: wavy;
		text-decoration-color: var(--negative_50);
	}
	.markdown-preview :global(a[data-link-status='unknown']) {
		text-decoration-line: underline;
		text-decoration-style: dotted;
	}
	.markdown-preview :global(a[data-link-status]) {
		cursor: help;
	}
	/* a sliver in the gutter, drawn outside the box so nothing reflows as the caret moves */
	.markdown-preview :global(.markdown-caret-block) {
		box-shadow: calc(-1 * var(--space_xs)) 0 0 0 var(--shade_20);
	}
</style>
