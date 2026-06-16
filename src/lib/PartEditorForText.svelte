<script lang="ts">
	import type {OmitStrict} from '@fuzdev/fuz_util/types.ts';
	import type {ComponentProps} from 'svelte';

	import {TextPart} from './part.svelte.ts';
	import ContentEditor from './ContentEditor.svelte';

	const {
		text_part,
		show_actions = true,
		...rest
	}: OmitStrict<ComponentProps<typeof ContentEditor>, 'content'> & {
		text_part: TextPart;
	} = $props();
</script>

<ContentEditor {...rest} bind:content={text_part.content} {show_actions} />
