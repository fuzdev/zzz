<script lang="ts">
	import type {SvelteHTMLElements} from 'svelte/elements';

	const {
		content,
		height = '200px',
		min_height = height,
		max_height = height,
		attrs,
	}: {
		content: string;
		height?: string | undefined;
		min_height?: string | undefined;
		max_height?: string | undefined;
		attrs?: SvelteHTMLElements['pre'] | undefined;
	} = $props();
</script>

<pre
	{...attrs}
	style:height
	style:min-height={min_height}
	style:max-height={max_height}
	class="flex:1 width:100% overflow:auto scrollbar-width:thin border_radius_xs font_family_sans font_size_sm shade_10 px_md py_xs {attrs?.class}">{content}</pre>
