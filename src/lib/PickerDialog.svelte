<script lang="ts" generics="T extends {id: Uuid}">
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';
	import Dialog from '@fuzdev/fuz_ui/Dialog.svelte';
	import type {ComponentProps} from 'svelte';

	import type {Uuid} from './zod_helpers.js';
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
		<div class="pane p_lg width_atmost_md mx_auto">
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
		</div>
	</Dialog>
{/if}
