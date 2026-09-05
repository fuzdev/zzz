<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';

	import type { Action } from './action.svelte.ts';
	import { frontend_context } from './frontend.svelte.ts';
	import { icon_delete, icon_log } from '@fuzdev/fuz_ui/icons.ts';
	import ContextmenuEntryCopyToClipboard from './ContextmenuEntryCopyToClipboard.svelte';

	const {
		action,
		...rest
	}: OmitStrict<ComponentProps<typeof Contextmenu>, 'entries'> & {
		action: Action;
		children: Snippet;
	} = $props();

	const app = frontend_context.get();
</script>

<Contextmenu {...rest} {entries} />

{#snippet entries()}
	<ContextmenuSubmenu icon={icon_log}>
		action
		{#snippet menu()}
			<ContextmenuEntryCopyToClipboard content={action.method} label="copy method" />

			<ContextmenuEntryCopyToClipboard content={action.id} label="copy id" />

			<ContextmenuEntryCopyToClipboard
				content={() => action.json_serialized}
				label="copy json data"
				show_preview={false}
			/>

			<!-- TODO implement `action.retry` or `actions.retry` or something -- see `app.api` too
			{#if action.has_error}
				<ContextmenuEntry
					icon={icon_retry}
					run={() => {
						console.log('Retry action:', action.method);
					}}
				>
					<span>retry action</span>
				</ContextmenuEntry>
			{/if} -->

			<ContextmenuEntry
				icon={icon_delete}
				run={() => {
					// TODO
					// eslint-disable-next-line no-alert
					if (confirm('delete this action from history? that sounds destructive')) {
						app.actions.items.remove(action.id);
					}
				}}
			>
				<span>delete from history</span>
			</ContextmenuEntry>
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}
