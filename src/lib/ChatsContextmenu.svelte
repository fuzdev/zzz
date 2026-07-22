<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';

	import { frontend_context } from './frontend.svelte.ts';
	import { icon_chat } from '@fuzdev/fuz_ui/icons.ts';

	const props: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & { children: Snippet } =
		$props();

	const app = frontend_context.get();
</script>

<Contextmenu {...props} {entries} />

{#snippet entries()}
	<ContextmenuEntry
		icon={icon_chat}
		run={() => {
			app.chats.add(undefined, true);
		}}
	>
		<span>create new chat</span>
	</ContextmenuEntry>
{/snippet}
