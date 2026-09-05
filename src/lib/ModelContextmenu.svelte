<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import ContextmenuLinkEntry from '@fuzdev/fuz_ui/ContextmenuLinkEntry.svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';

	import type { Model } from './model.svelte.ts';
	import { icon_chat, icon_model } from '@fuzdev/fuz_ui/icons.ts';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';

	const {
		model,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		model: Model | undefined;
		children: Snippet;
	} = $props();
</script>

<Contextmenu {...rest} {entries} />

<!-- TODO maybe extract ModelContextmenuEntries that can be used elsewhere like the ModelLink as an action? -->
{#snippet entries()}
	{#if model}
		<ContextmenuSubmenu icon={icon_model}>
			model

			{#snippet menu()}
				<ContextmenuLinkEntry href="/models/{model.name}" icon={icon_model} />

				<ContextmenuEntryCopyToClipboard content={model.name} label="copy name" />

				<ContextmenuEntry
					icon={icon_chat}
					run={() => model.app.chats.add(undefined, true).add_thread(model)}
				>
					<span>create new chat</span>
				</ContextmenuEntry>

				<!-- TODO probably want an "edit model" form, this is confusing as-is -->
				<!-- <ContextmenuSubmenu icon={icon_provider}>
				set provider

				{#snippet menu()}
					{#each model.app.providers.names as provider_name (provider_name)}
						<ContextmenuEntry
							icon={model.provider_name === provider_name ? icon_checkmark : undefined}
							run={() => {
								model.provider_name = provider_name;
							}}
						>
							<span>{provider_name}</span>
						</ContextmenuEntry>
					{/each}
				{/snippet}
			</ContextmenuSubmenu> -->
			{/snippet}
		</ContextmenuSubmenu>
	{/if}
{/snippet}
