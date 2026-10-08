<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';

	import type { PartUnion } from './part.svelte.ts';
	import type { PartOwner } from './part_helpers.ts';
	import { icon_remove } from '@fuzdev/fuz_ui/icons.ts';
	import Icon from './Icon.svelte';

	const {
		part,
		owner,
		...rest
	}: OmitStrict<SvelteHTMLElements['button'], 'part'> & {
		part: PartUnion;
		owner: PartOwner;
	} = $props();

	// parts are often unnamed, so fall back to the file path, else no label
	const label = $derived(
		part.name
			? `"${part.name}"`
			: part.type === 'diskfile' && part.path
				? `"${part.diskfile?.path_relative || part.path}"`
				: null
	);
</script>

<ConfirmButton
	{...rest}
	onconfirm={() => {
		owner.remove_part(part.id);
	}}
	class="plain sized_sm"
	title={label ? `remove part ${label}` : 'remove part'}
>
	<Icon data={icon_remove} />
</ConfirmButton>
