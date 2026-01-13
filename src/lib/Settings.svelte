<script lang="ts">
	import ColorSchemeInput from '@fuzdev/fuz_ui/ColorSchemeInput.svelte';
	import ThemeInput from '@fuzdev/fuz_ui/ThemeInput.svelte';

	import ExternalLink from './ExternalLink.svelte';
</script>

<h3>color scheme</h3>
<div class="width_upto_sm mb_lg">
	<!-- TODO wanted to add `flex:1` to the buttons here, maybe add `menu_attrs` and `button_attrs`  -->
	<ColorSchemeInput />
</div>
<p>
	Learn about <code>color-scheme</code> on <ExternalLink
		href="https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme">MDN</ExternalLink
	>.
</p>
<h3>theme</h3>
<aside>
	⚠️ Themes are a proof of concept, not ready for production. For technical docs see <ExternalLink
		href="https://css.fuz.dev/docs/themes">fuz_css</ExternalLink
	>.
</aside>
<div class="width_upto_sm box">
	<div class="width_upto_xs">
		<ThemeInput />
	</div>
</div>
