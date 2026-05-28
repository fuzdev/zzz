<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import ContextmenuLinkEntry from '@fuzdev/fuz_ui/ContextmenuLinkEntry.svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import type {Model} from './model.svelte.js';
	import {GLYPH_MODEL, GLYPH_CHAT} from './glyphs.js';
	import Glyph from './Glyph.svelte';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';

	const {
		model,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		model: Model;
		children: Snippet;
	} = $props();
</script>

<Contextmenu {...rest} {entries} />

<!-- TODO maybe extract ModelContextmenuEntries that can be used elsewhere like the ModelLink as an action? -->
{#snippet entries()}
	<ContextmenuSubmenu>
		{#snippet icon()}<Glyph glyph={GLYPH_MODEL} />{/snippet}
		model

		{#snippet menu()}
			<ContextmenuLinkEntry href="/models/{model.name}">
				{#snippet icon()}<Glyph glyph={GLYPH_MODEL} />{/snippet}
			</ContextmenuLinkEntry>

			<ContextmenuEntryCopyToClipboard content={model.name} label="copy name" />

			<ContextmenuEntry run={() => model.app.chats.add(undefined, true).add_thread(model)}>
				{#snippet icon()}<Glyph glyph={GLYPH_CHAT} />{/snippet}
				<span>create new chat</span>
			</ContextmenuEntry>

			<!-- TODO probably want an "edit model" form, this is confusing as-is -->
			<!-- <ContextmenuSubmenu>
				{#snippet icon()}<Glyph glyph={GLYPH_PROVIDER} />{/snippet}
				set provider

				{#snippet menu()}
					{#each model.app.providers.names as provider_name (provider_name)}
						<ContextmenuEntry
							run={() => {
								model.provider_name = provider_name;
							}}
						>
							{#snippet icon()}
								{#if model.provider_name === provider_name}<Glyph glyph={GLYPH_CHECKMARK} />{/if}
							{/snippet}
							<span>{provider_name}</span>
						</ContextmenuEntry>
					{/each}
				{/snippet}
			</ContextmenuSubmenu> -->
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}
