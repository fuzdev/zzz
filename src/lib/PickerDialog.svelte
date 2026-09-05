<script lang="ts" generics="T extends {id: Uuid}">
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import type { Uuid } from '@fuzdev/fuz_util/id.ts';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';
	import DialogContent from '@fuzdev/fuz_ui/DialogContent.svelte';
	import type { ComponentProps } from 'svelte';

	import Picker from './Picker.svelte';

	let {
		onpick,
		show = $bindable(false),
		dialog_props,
		...rest
	}: // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
		ComponentProps<typeof Picker<T>> & {
			show?: boolean | undefined;
			dialog_props?: OmitStrict<ComponentProps<typeof Dialog>, 'children'> | undefined;
		} = $props();
</script>

<!-- TODO API with `bind:show` in Fuz dialog? -->
{#if show}
	<Dialog
		{...dialog_props}
		onclose={() => {
			onpick(undefined);
			show = false;
		}}
	>
		<DialogContent>
			<Picker
				{...rest}
				onpick={(item) => {
					// If onpick returns false explicitly, don't close the picker
					const should_close = onpick(item) !== false;
					if (should_close) {
						show = false;
					}
				}}
			/>
		</DialogContent>
	</Dialog>
{/if}
