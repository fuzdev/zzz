<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import type { Thunk } from '@fuzdev/fuz_util/function.ts';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import type { ContextmenuActivateResult } from '@fuzdev/fuz_ui/contextmenu_state.svelte.ts';

	import { icon_copy } from '@fuzdev/fuz_ui/icons.ts';
	import { to_preview } from './helpers.ts';

	const {
		content,
		load_content,
		label = 'copy',
		preview,
		preview_limit,
		show_preview = true,
		children,
		...rest
	}: OmitStrict<ComponentProps<typeof ContextmenuEntry>, 'run' | 'children'> & {
		content: string | Thunk<string> | undefined;
		/**
		 * Given only while `content` may change on loading — a file still to
		 * load, or a failed read to retry once: a click awaits it and copies
		 * what it resolves to, `''` included, nothing for `null` or
		 * `undefined`; a rejection's message shows on the entry, which stays
		 * open. `content` and `preview` then only preview. Without it a click
		 * copies `content` at once, with no await before the write, so the
		 * browser still sees the click's user activation. When the write after
		 * a load is refused (the wait outlasted the click's user activation),
		 * the entry stays open saying "loaded — copy again", and its next click
		 * writes what was loaded at once, without loading again.
		 */
		load_content?: (() => Promise<string | null | undefined>) | undefined;
		label?: string | undefined;
		preview?: string | undefined;
		preview_limit?: number | undefined;
		show_preview?: boolean | undefined; // TODO maybe rename to `nopreview`?
		children?: Snippet | undefined;
	} = $props();

	const read_content = () => (typeof content === 'function' ? content() : content);

	const final_preview: string | undefined = $derived(
		show_preview ? to_preview(preview ?? read_content(), preview_limit) : undefined
	);

	/**
	 * What a load resolved to when its write was refused — the next click
	 * writes it at once, so "copy again" never waits on another load (a read
	 * that keeps failing would ask again forever). This entry's own: it
	 * unmounts with its menu.
	 */
	let loaded: string | null = null;

	const copy_to_clipboard = (): ContextmenuActivateResult | Promise<ContextmenuActivateResult> => {
		if (loaded !== null) return copy_now(loaded);
		if (load_content) return copy_loaded(load_content);
		const c = read_content();
		if (!c) return;
		try {
			// no await before the write — see `load_content`
			return navigator.clipboard.writeText(c).then(
				() => undefined,
				(error: unknown) => {
					console.error('failed to copy text: ', error);
				}
			);
		} catch (error) {
			console.error('failed to copy text: ', error);
		}
	};

	/** Writes what an earlier load got, with no await before the write. */
	const copy_now = (c: string): ContextmenuActivateResult | Promise<ContextmenuActivateResult> => {
		try {
			return navigator.clipboard.writeText(c).then(
				() => {
					loaded = null;
				},
				(error: unknown) => {
					console.error('failed to copy text: ', error);
				}
			);
		} catch (error) {
			console.error('failed to copy text: ', error);
		}
	};

	const copy_loaded = async (
		load: () => Promise<string | null | undefined>
	): Promise<ContextmenuActivateResult> => {
		// a rejection is the menu's to show — it keeps the menu open with the message
		const c = await load();
		// an empty file copies as empty — only no content at all copies nothing
		if (c == null) return;
		try {
			await navigator.clipboard.writeText(c);
		} catch (error) {
			// the wait can outlast the click's user activation — loaded now, so
			// the menu stays open and a second click copies at once
			console.error('failed to copy text: ', error);
			loaded = c;
			return { ok: false, message: 'loaded — copy again' };
		}
	};
</script>

<ContextmenuEntry icon={icon_copy} run={copy_to_clipboard} {...rest}>
	{#if children}
		{@render children()}
	{:else}
		<span>
			{label}
			{#if final_preview}
				<small class="ml_xs">{final_preview}</small>
			{/if}
		</span>
	{/if}
</ContextmenuEntry>
