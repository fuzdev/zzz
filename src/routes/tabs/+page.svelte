<script lang="ts">
	import {GLYPH_TAB} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';
	import {Browser} from '$routes/tabs/browser.svelte.js';
	import {sample_tabs} from '$routes/tabs/sample_tabs.js';
	import BrowserView from '$routes/tabs/BrowserView.svelte';
	import {frontend_context} from '$lib/frontend.svelte.js';
	import ExternalLink from '$lib/ExternalLink.svelte';

	const app = frontend_context.get();

	// TODO super hacky but w/e, inits app.browser to the global
	const browser: Browser = ((app as any).browser ??= new Browser({
		app,
		json: {tabs: sample_tabs},
	}));
</script>

{#if browser.browserified}
	<BrowserView {browser}>
		{@render content()}
	</BrowserView>
{:else}
	<div class="p_lg">
		{@render content()}
	</div>
{/if}

{#snippet content()}
	<h1><Glyph glyph={GLYPH_TAB} /> tabs</h1>

	<section class="width_atmost_md">
		{#if browser.browserified}
			<aside>
				⚠️⚠️ This is just a demo of planned functionality, nothing works like it should. Zzz needs a
				native installation to function like a real browser. Long term, a user-friendly design would
				allow choosing your engine among Chromium, Firefox, Safari, Servo, Ladybird, etc.
			</aside>
		{/if}
		<p>
			Zzz can be used to build installable apps that extend the web browser, using the form factor
			you already know well -- imagine your current browser, and then add a sidebar on the left like
			the one on this page, then <button
				type="button"
				onclick={() => (browser.browserified = !browser.browserified)}
				class:color_i={!browser.browserified}
				class:color_h={browser.browserified}
				class="inline compact">{browser.browserified ? 'un' : ''}browserify!</button
			> I'm planning to make a native version of Zzz.
		</p>
		<p>
			And users don't have to buy in, either -- the basic browser UX is unchanged. Press <code
				>[backtick `]</code
			>
			to
			<button
				type="button"
				class="inline compact"
				class:color_d={app.ui.show_sidebar}
				class:color_f={!app.ui.show_sidebar}
				onclick={() => {
					app.ui.toggle_sidebar();
					if (!browser.browserified) {
						browser.browserified = true;
					}
				}}
				>{#if !app.ui.show_sidebar}remember your power{:else}pretend it's all a dream{/if}</button
			> (that's just the current keybinding, it will probably change, also see the button at the bottom
			left corner of this window)
		</p>
		<p>
			This simple change recontextualizes the web's UX -- instead of the browser being its own silo,
			users compose tabs in a larger integrated system that's open and extensible by design.
		</p>
		<p>
			As a simple example, you could add metadata like tags to both your browser tabs and files,
			both local and in the cloud, so you can find things no matter their type or location. Maybe
			you want to summon UI that leverages that data for specific needs in specific contexts --
			without any technical knowledge, third parties, or unnecessary friction. The best usecases are
			still unknown, and today's browsers weren't designed for LLMs or experimentation at this
			level.
		</p>
		<p>
			I think that by optimizing for UX, Zzz and a lot of software is converging on similar
			architectures. I'm not well-read in The Literature or staying current with the design or
			product communities, but some of my favorite writing is from Ink and Switch: <ExternalLink
				href="https://www.inkandswitch.com/local-first/">local-first</ExternalLink
			> and <ExternalLink href="https://www.inkandswitch.com/malleable-software/"
				>malleable software</ExternalLink
			>. I think that we can all have software that's really nice to use, not that expensive to
			produce, that also respects individual rights and is designed for our benefit, that
			<small class="font_size_xs">UNLEASHES THE FULL POWER OF THE WEB</small>, and integrates our
			experience across the web and our devices how we each prefer.
		</p>
	</section>
{/snippet}
