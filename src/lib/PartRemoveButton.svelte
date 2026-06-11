<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.js';
	import ConfirmButton from '@fuzdev/fuz_app/ui/ConfirmButton.svelte';

	import type {PartUnion} from './part.svelte.js';
	import type {Prompt} from './prompt.svelte.js';
	import type {Prompts} from './prompts.svelte.js';
	import {icon_remove} from '@fuzdev/fuz_ui/icons.js';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	const {
		part,
		prompt,
		prompts,
		...rest
	}: OmitStrict<SvelteHTMLElements['button'], 'part'> & {
		part: PartUnion;
		prompt?: Prompt | undefined;
		prompts?: Prompts | undefined;
	} = $props();
</script>

<ConfirmButton
	{...rest}
	onconfirm={() => {
		if (prompt) {
			prompt.remove_part(part.id);
		} else if (prompts) {
			prompts.remove_part(part.id);
		}
	}}
	class="plain sm"
	title="remove part {'"' + part.name + '"'}"
>
	<Svg data={icon_remove} />
</ConfirmButton>
