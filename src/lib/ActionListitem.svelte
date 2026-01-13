<script lang="ts">
	import {slide} from 'svelte/transition';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import Glyph from './Glyph.svelte';
	import type {Action} from './action.svelte.js';
	import {get_glyph_for_action_method, get_glyph_for_action_kind, GLYPH_ERROR} from './glyphs.js';
	import ActionContextmenu from './ActionContextmenu.svelte';

	const {
		action,
		selected = false,
		onselect,
	}: {
		action: Action;
		selected?: boolean;
		onselect?: ((action: Action) => void) | undefined;
	} = $props();
</script>

<!-- TODO hoist the transition? -->
<ActionContextmenu {action}>
	<button
		type="button"
		class="width:100% text-align:left justify-content:start py_xs px_md border_radius_0 border-style:none box_shadow_none"
		class:selected
		class:color_c={action.has_error}
		onclick={() => {
			onselect?.(action);
		}}
		transition:slide
	>
		<div class="font-weight:400 display:flex align-items:center gap_xs width:100%">
			<Glyph glyph={get_glyph_for_action_method(action.method)} />
			<Glyph glyph={get_glyph_for_action_kind(action.kind)} />
			<span class="font_family_mono flex:1 ellipsis">{action.method}</span>
			{#if action.pending}
				<PendingAnimation inline />
			{:else if action.has_error}
				<Glyph class="color_c" glyph={GLYPH_ERROR} />
			{/if}
			<small class="font_family_mono ml_auto">{action.created_formatted_time}</small>
		</div>
	</button>
</ActionContextmenu>
