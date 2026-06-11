<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import type {Thunk} from '@fuzdev/fuz_util/function.js';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import {icon_copy} from '@fuzdev/fuz_ui/icons.js';
	import {to_preview} from './helpers.js';

	const {
		content,
		label = 'copy',
		preview,
		preview_limit,
		show_preview = true,
		children,
		...rest
	}: OmitStrict<ComponentProps<typeof ContextmenuEntry>, 'run' | 'children'> & {
		content: string | Thunk<string> | undefined;
		label?: string | undefined;
		preview?: string | undefined;
		preview_limit?: number | undefined;
		show_preview?: boolean | undefined; // TODO maybe rename to `nopreview`?
		children?: Snippet | undefined;
	} = $props();

	const read_content = () => (typeof content === 'function' ? content() : content);

	const final_preview: string | undefined = $derived(
		show_preview ? to_preview(preview ?? read_content(), preview_limit) : undefined,
	);

	const copy_to_clipboard = async (): Promise<void> => {
		const c = read_content();
		if (!c) return;
		try {
			await navigator.clipboard.writeText(c);
		} catch (error) {
			console.error('failed to copy text: ', error);
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
