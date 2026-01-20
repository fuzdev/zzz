<script lang="ts">
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';

	import {logo_zzz} from './logos.js';
	import CapabilityWebsocket from './CapabilityWebsocket.svelte';
	import CapabilityFilesystem from './CapabilityFilesystem.svelte';
	import Glyph from './Glyph.svelte';
	import ProviderLogo from './ProviderLogo.svelte';
	import {GLYPH_CONNECT, GLYPH_DIRECTORY, GLYPH_BACKEND} from './glyphs.js';
	import CapabilityProvider from './CapabilityProvider.svelte';
	import CapabilityBackend from './CapabilityBackend.svelte';
	import CapabilitySystem from './CapabilitySystem.svelte';

	// TODO add ping button that forces websocket transport
</script>

<div class="width_atmost_md">
	<section>
		<section class="mb_xl12">
			<h2><Glyph glyph={GLYPH_BACKEND} /> backend</h2>
			<CapabilityBackend />
		</section>
		<section class="mb_xl12">
			<h2><Glyph glyph={GLYPH_DIRECTORY} /> backend filesystem</h2>
			<CapabilityFilesystem />
		</section>
		<section class="mb_xl12">
			<h2><Glyph glyph={GLYPH_CONNECT} /> backend websocket</h2>
			<p>
				Websockets are an optional transport that's preferred by default. Zzz currently relies on
				websockets for pushed updates like filesystem changes -- SSE will be supported as an option
				in the future.
			</p>
			<CapabilityWebsocket />
		</section>
		<section class="mb_xl12">
			<h2><ProviderLogo name="ollama" /> Ollama</h2>
			<CapabilityProvider provider_name="ollama" />
		</section>
		<section class="mb_xl12">
			<h2><ProviderLogo name="claude" /> Claude</h2>
			<CapabilityProvider provider_name="claude" />
		</section>
		<section class="mb_xl12">
			<h2><ProviderLogo name="chatgpt" /> ChatGPT</h2>
			<CapabilityProvider provider_name="chatgpt" />
		</section>
		<section class="mb_xl12">
			<h2><ProviderLogo name="gemini" /> Gemini</h2>
			<CapabilityProvider provider_name="gemini" />
		</section>
		<section class="mb_xl12">
			<h2>
				<Svg data={logo_zzz} size="var(--icon_size_sm)" fill="var(--text_color)" inline /> system
			</h2>
			<CapabilitySystem />
		</section>
	</section>
</div>
