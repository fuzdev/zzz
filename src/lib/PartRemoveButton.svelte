<script lang="ts">
	import type { SvelteHTMLElements } from 'svelte/elements';
	import type { OmitStrict } from '@fuzdev/fuz_util/types.ts';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';

	import type { PartUnion } from './part.svelte.ts';
	import type { PartOwner } from './part_helpers.ts';
	import { icon_remove } from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	const {
		part,
		owner,
		...rest
	}: OmitStrict<SvelteHTMLElements['button'], 'part'> & {
		part: PartUnion;
		owner: PartOwner;
	} = $props();
</script>

<ConfirmButton
	{...rest}
	onconfirm={() => {
		owner.remove_part(part.id);
	}}
	class="plain sm"
	title="remove part {'"' + part.name + '"'}"
>
	<Svg data={icon_remove} />
</ConfirmButton>
