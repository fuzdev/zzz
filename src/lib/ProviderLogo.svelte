<script lang="ts">
	import type {ComponentProps} from 'svelte';
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import type {OmitStrict} from '@fuzdev/fuz_util/types.ts';

	import {logo_chatgpt, logo_claude, logo_gemini} from './logos.ts';
	import type {ProviderName} from './provider_types.ts';

	const {
		name,
		fill = 'var(--text_color)',
		size = 'var(--font_size, var(--font_size_xl))', // TODO remove after changing the default in Svg.svelte upstream
		inline = true,
		...rest
	}: OmitStrict<ComponentProps<typeof Svg>, 'data'> & {
		name: ProviderName;
		fill?: string | null | undefined;
		size?: string | undefined;
		inline?: boolean | undefined;
	} = $props();

	const provider_logos = {
		chatgpt: logo_chatgpt,
		claude: logo_claude,
		gemini: logo_gemini,
	};
</script>

<Svg shrink={false} {...rest} data={provider_logos[name]} {fill} {size} {inline} />
