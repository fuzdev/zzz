<script lang="ts">
	import {slide} from 'svelte/transition';
	import PendingAnimation from '@fuzdev/fuz_ui/PendingAnimation.svelte';

	import {icon_error} from '@fuzdev/fuz_ui/icons.ts';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	import type {Action} from './action.svelte.ts';
	import {get_icon_for_action_method, get_icon_for_action_kind} from './action_icons.ts';
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
		class="width:100% text-align:left justify-content:start py_xs px_md border-radius:0 border-style:none box_shadow_none"
		class:selected
		class:palette_c={action.has_error}
		onclick={() => {
			onselect?.(action);
		}}
		transition:slide
	>
		<div class="font-weight:400 display:flex align-items:center gap_xs width:100%">
			<Svg data={get_icon_for_action_method(action.method)} />
			<Svg data={get_icon_for_action_kind(action.kind)} />
			<span class="font_family_mono flex:1 ellipsis">{action.method}</span>
			{#if action.pending}
				<PendingAnimation inline />
			{:else if action.has_error}
				<Svg class="palette_c" data={icon_error} />
			{/if}
			<small class="font_family_mono ml_auto">{action.created_formatted_time}</small>
		</div>
	</button>
</ActionContextmenu>
