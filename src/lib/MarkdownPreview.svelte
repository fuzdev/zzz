<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';
	import Mdz from '@fuzdev/mdz/Mdz.svelte';

	/**
	 * Rendered markdown, read-only — a file's content, or any markdown
	 * string. Scrolls on its own, so it can sit beside an editor; it takes
	 * focus like an editor does (`focus_key`), so arrow keys scroll it.
	 *
	 * @module
	 */

	// TODO links that open in zzz and flag broken relative paths, an outline, and highlighted
	// codeblocks plug in here, as mdz contexts set around `Mdz`

	let {
		content,
		focus_key,
		pending_element_to_focus_key = $bindable(),
		attrs
	}: {
		/** The markdown source to render. */
		content: string;
		/** Focuses the preview when `pending_element_to_focus_key` equals it, then clears that. */
		focus_key?: string | number | null | undefined;
		pending_element_to_focus_key?: string | number | null | undefined;
		/** Attributes for the scroll container. */
		attrs?: SvelteHTMLElements['div'] | undefined;
	} = $props();

	const empty = $derived(!content.trim());

	// TODO replace with in-zzz link handling: relative links open the file they name, and
	// in-document fragments scroll without touching the URL - until then a link into the app is inert,
	// since following one would leave the files page (and drop its `?workspace=`)
	/**
	 * Keeps the preview's links from navigating the app: a link to another
	 * origin opens in a new tab (mdz already marks its external links so), an
	 * in-document `#fragment` scrolls to its heading in the preview, and any
	 * other same-origin link — relative, root-relative, query-only — does
	 * nothing, modifier-clicks included.
	 */
	const handle_click = (event: MouseEvent): void => {
		if (event.defaultPrevented || event.button !== 0) return;
		const container = event.currentTarget;
		if (!(container instanceof HTMLElement) || !(event.target instanceof Element)) return;
		const anchor = event.target.closest('a[href]');
		if (!(anchor instanceof HTMLAnchorElement) || !container.contains(anchor)) return;

		const href = anchor.getAttribute('href') ?? '';
		let url: URL;
		try {
			url = new URL(href, location.href);
		} catch {
			event.preventDefault();
			return;
		}
		if (url.origin !== location.origin) {
			// `mailto:` and the like hand off to another app without leaving the page
			if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
			if (anchor.target === '_blank') return;
			event.preventDefault();
			if (!(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) {
				window.open(url.href, '_blank', 'noopener');
			}
			return;
		}
		event.preventDefault();
		if (href.startsWith('#') && href.length > 1) {
			let id = href.slice(1);
			try {
				id = decodeURIComponent(id);
			} catch {
				// a malformed escape matches no heading as written, so look for it raw
			}
			for (const el of container.querySelectorAll('[id]')) {
				if (el.id === id) {
					el.scrollIntoView?.();
					break;
				}
			}
		}
	};
</script>

<div
	tabindex="-1"
	{...attrs}
	class={['overflow:auto', attrs?.class]}
	onclick={(event) => {
		attrs?.onclick?.(event);
		handle_click(event);
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
		{#if empty}
			<p class="text_50">nothing to preview</p>
		{:else}
			<Mdz {content} />
		{/if}
	</div>
</div>
