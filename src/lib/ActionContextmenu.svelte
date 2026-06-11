<script lang="ts">
	import type {ComponentProps, Snippet} from 'svelte';
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
	import ContextmenuSubmenu from '@fuzdev/fuz_ui/ContextmenuSubmenu.svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';

	import type {Action} from './action.svelte.js';
	import {frontend_context} from './frontend.svelte.js';
	import {icon_delete, icon_log} from '@fuzdev/fuz_ui/icons.js';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
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
	<ContextmenuSubmenu>
		{#snippet icon()}<Svg data={icon_log} />{/snippet}
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
					run={() => {
						console.log('Retry action:', action.method);
					}}
				>
					{#snippet icon()}<Svg data={icon_retry} />{/snippet}
					<span>retry action</span>
				</ContextmenuEntry>
			{/if} -->

			<ContextmenuEntry
				run={() => {
					// TODO
					// eslint-disable-next-line no-alert
					if (confirm('delete this action from history? that sounds destructive')) {
						app.actions.items.remove(action.id);
					}
				}}
			>
				{#snippet icon()}<Svg data={icon_delete} />{/snippet}
				<span>delete from history</span>
			</ContextmenuEntry>
		{/snippet}
	</ContextmenuSubmenu>
{/snippet}
