<script lang="ts">
	import Svg from '@fuzdev/fuz_ui/Svg.svelte';
	import LibraryDetail from '@fuzdev/fuz_ui/LibraryDetail.svelte';
	import EcosystemLinksPanel from '@fuzdev/fuz_ui/EcosystemLinksPanel.svelte';
	import {resolve} from '$app/paths';
	import Details from '@fuzdev/fuz_ui/Details.svelte';
	import {DEV} from 'esm-env';

	import {logo_zzz} from '$lib/logos.js';
	import {library_context} from '$lib/library.js';
	import ExternalLink from '$lib/ExternalLink.svelte';
	import PageFooter from '$routes/PageFooter.svelte';
	import {frontend_context} from '$lib/frontend.svelte.js';

	const library = library_context.get();
	const app = frontend_context.get();

	// TODO probably link to a blog post that's more approachable and less technical
</script>

<div class="width_atmost_md p_lg">
	<section>
		<header class="mb_xl5" style:--font_size="var(--font_size_xl)">
			<h1 class="row">
				<Svg
					data={logo_zzz}
					fill="var(--text_color)"
					size="var(--icon_size_sm)"
					class="ml_xs mr_xl"
				/> about
			</h1>
		</header>
		<blockquote>nice web things for the tired 💤</blockquote>
		<p>
			Zzz, pronounced "zees" like bees, is a local-first forge for power users and developers. The
			idea is to make an integrated cross-platform environment that adapts to your needs and intent
			while remaining fully open, aligned, and designed for your autonomy. It's both a customizable
			web UI and local-first backend for power users, and a flexible tool for crafting UX-maximizing
			websites with a streamlined developer experience, eventually accessible to non-coders (hence
			all the AI).
		</p>
		<aside>
			⚠️ This is an early pre-release, see the
			<ExternalLink href="https://github.com/fuzdev/zzz">repo</ExternalLink>
			and
			<ExternalLink href="https://github.com/fuzdev/zzz/discussions">discussions</ExternalLink> 💤
		</aside>
		<p>Some early (rough) integrations include:</p>
		<ul>
			<li>
				<ExternalLink href="https://hono.dev/">Hono</ExternalLink> is the backend web server that provides
				local system access. It's uses web standards and supports all JS server runtimes.
			</li>
			<li>
				<ExternalLink href="https://svelte.dev/">SvelteKit</ExternalLink> is the frontend framework. Hono
				integrates with its Node adapter, and it uses <ExternalLink href="https://vite.dev/"
					>Vite</ExternalLink
				> in development.
			</li>
			<li>
				AI providers with <ExternalLink href="https://github.com/openai/openai-node"
					>ChatGPT</ExternalLink
				>,
				<ExternalLink href="https://github.com/anthropics/anthropic-sdk-typescript"
					>Claude</ExternalLink
				>, and <ExternalLink href="https://github.com/google-gemini/generative-ai-js"
					>Gemini</ExternalLink
				> -- bring your own API keys
			</li>
			<li>
				<ExternalLink href="https://github.com/ollama/ollama">Ollama</ExternalLink> runs AI models locally
				with easy installation and onboarding. I plan to support more local LLM backends like
				<ExternalLink href="https://github.com/ggml-org/llama.cpp">llama.cpp</ExternalLink> which Ollama
				is based on.
			</li>
		</ul>
		<p>Planned integrations:</p>
		<ul>
			<li>
				<!-- TODO @db -->
				<ExternalLink href="https://github.com/electric-sql/pglite">pglite</ExternalLink>
				and full <ExternalLink href="https://www.postgresql.org/">Postgres</ExternalLink> when desired,
				using <ExternalLink href="https://github.com/porsager/postgres">Postgres.js</ExternalLink>
				and probably <ExternalLink href="https://github.com/drizzle-team/drizzle-orm"
					>Drizzle</ExternalLink
				>, see <ExternalLink href="https://github.com/fuzdev/zzz/issues/7">issue #7</ExternalLink>
			</li>
			<li>
				<ExternalLink href="https://modelcontextprotocol.io/">Model Context Protocol</ExternalLink>,
				maybe others like <ExternalLink href="https://github.com/google/A2A"
					>Agent2Agent (A2A) protocol</ExternalLink
				>
			</li>
			<li>
				<ExternalLink href="https://wikipedia.org/wiki/RSS">RSS</ExternalLink> and <ExternalLink
					href="https://wikipedia.org/wiki/Atom_(web_standard)">Atom</ExternalLink
				> and <ExternalLink href="https://wikipedia.org/wiki/JSON_Feed">JSON Feed</ExternalLink>
			</li>
			<li>git!</li>
			<li>
				I think it makes sense to prioritize a few high-utility integrations for manipulating media
				files, like <ExternalLink href="https://pandoc.org/">Pandoc</ExternalLink>,
				<ExternalLink href="https://ffmpeg.org/">ffmpeg</ExternalLink>, and <ExternalLink
					href="https://imagemagick.org/">ImageMagick</ExternalLink
				>
			</li>
			<li>
				when I regain an appetite for social, <ExternalLink href="https://atproto.com/"
					>AT Protocol</ExternalLink
				> and <ExternalLink href="https://activitypub.rocks/">ActivityPub</ExternalLink> -- probably both
				but they're not immediate prioritie (I have an initial <ExternalLink
					href="https://github.com/fuzdev/fuz_mastodon">Mastodon integration</ExternalLink
				> with readonly embedded posts)
			</li>
			<li>
				more, input welcome
				<ul>
					<li>
						the system is being designed for extensibility, so your use cases are helpful for
						shaping it
					</li>
					<li>
						devs can extend Zzz without artifcial restriction in their own projects, but Zzz should
						provide a complete system with useful defaults and optional high-quality first-party
						integrations
					</li>
					<li>
						some decisions like Postgres, TypeScript, and Svelte limit user choice -- you can always
						bring other databases and frontend frameworks, but don't expect full integration or
						reasonable performance; for example there is a serious mismatch with sqlite
					</li>
				</ul>
			</li>
		</ul>
		<p>
			If this sounds interesting and you would like to test out some rickety pre-release software,
			feedback is appreciated to help make it work for you -- see the
			<ExternalLink href="https://github.com/fuzdev/zzz/issues">issues</ExternalLink> and
			<ExternalLink href="https://github.com/fuzdev/zzz/discussions">discussions</ExternalLink>.
		</p>
	</section>
	<hr />
	<section>
		<h2 class="mb_lg">More details</h2>
		<ul>
			<li>Zzz is free and open source and permissively licensed</li>
			<li>it's a noncommercial project and its only official domain is zzz.software</li>
			<li>
				I'm looking for <ExternalLink href="https://www.ryanatkn.com/funding">funding</ExternalLink>
				to sustain my continued work on it
			</li>
		</ul>
	</section>
	<hr />
	<section>
		<h2 class="mb_lg">Peek a possible future</h2>
		<p class="mb_md">
			This project has a big speculative scope and it's early in development. What you're seeing is
			a small part of the idea -- especially if you're viewing this on the website not natively via
			Node -- so here's a button for previewing some of what's planned:
		</p>
		<button
			type="button"
			class:color_h={app.futuremode}
			onclick={() => {
				app.futuremode = !app.futuremode;
			}}
		>
			<Svg
				data={logo_zzz}
				size="var(--icon_size_sm)"
				fill={app.futuremode ? 'var(--color_h_50)' : 'var(--text_color)'}
				class="mr_md {app.futuremode ? ' transform:scaleX(-1)' : ''}"
				style="transition: transform 200ms ease"
			/>
			<span
				><span class="display:inline-block text-align:right" style:width="6ch"
					>{app.futuremode ? 'disable' : 'enable'}</span
				>
				futuremode</span
			>
			<Svg
				data={logo_zzz}
				size="var(--icon_size_sm)"
				fill={app.futuremode ? 'var(--color_h_50)' : 'var(--text_color)'}
				class="ml_md {app.futuremode ? '' : ' transform:scaleX(-1)'}"
				style="transition: transform 200ms ease"
			/>
		</button>
	</section>
	<hr />
	<section>
		<h2 class="mb_lg">Security</h2>
		<p>
			Zzz is a powerful and extensible system, and that means it carries significant security risks.
			Although it can be used to build simple and secure websites, the Zzz backend is capable like
			an IDE and can do bad things when bidden.
		</p>
		<p>
			Zzz puts the user in control, so if you insist on installing obvious_malware, Zzz will abide.
			This basic tension between power and safety leads me to think that UX design should be a
			primary mechanism of influence to protect users -- instead of restricting power from user
			control, we'll design for its safe usage, including clear visibility into your delegation
			situation. Maybe you'll have to click through an annoying UI and 2FA, obviously breaking the
			seal, to install the malware. Every person and situation may have a different threat model, so
			we want to make it easy to make good choices, where lazy is secure.
		</p>
		<aside>
			⚠️ I am not a security professional and Zzz has not been audited; it may be <strong
				class="color_c_50">dangerous</strong
			> to run and there is no auth yet
		</aside>
		<p>
			My current plan is to extract <ExternalLink href="https://github.com/fuzdev/fuz_ui"
				>a reusable framework</ExternalLink
			> out of Zzz that prioritizes security from the first commit. More on that soon. For now Zzz is
			insecure and should definitely not be run in production, and it should be used with caution in development.
		</p>
		<p>More thoughts about security:</p>
		<ul>
			<li>
				Zzz's Node server can do things like:
				<ul>
					<li>
						read and write to the Zzz app directory (<code>PUBLIC_ZZZ_DIR</code>, defaults to
						<code>./.zzz</code>) for app data like completions, plus any additional paths configured
						in <code>PUBLIC_ZZZ_SCOPED_DIRS</code> for user files -- all filesystem operations are
						securely scoped via <code>ScopedFs</code> (symlinks rejected, paths validated) -- this opens
						a significant surface area for both you and attackers to use, and writing untrusted data could
						lead to arbitrary code execution if, for example, you're running a hot reloading dev server
						in a scoped directory (configure with care!)
					</li>
					<li>
						use your API keys for calls to Claude, ChatGPT, and Gemini, and write them to <code
							>./.env.{DEV ? 'development' : 'production'}</code
						>
					</li>
					<li>call Ollama's API if available -- low risk</li>
					<li>
						<strong class="color_c_50">there is no authentication yet</strong>, only an origin
						check, so do not use this in production
					</li>
					<li>
						soon, more integrations including terminal access assuming Bash, but nothing that
						powerful before auth
					</li>
				</ul>
			</li>
			<li>
				The frontend <ExternalLink
					href="https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/ContentSecurityPolicy"
					>CSP</ExternalLink
				> is fairly locked down, including blocking all unknown network connections. For details, see
				the CSP config in <ExternalLink
					href="https://github.com/fuzdev/zzz/blob/main/svelte.config.js"
					>svelte.config.js</ExternalLink
				> and the <ExternalLink href="https://ui.fuz.dev/docs/csp">Fuz CSP docs</ExternalLink>.
				Configuration will be needed for many usecases, unlocking shenanigans good and bad, so we'll
				tread carefully.
			</li>
			<li>
				There are no mechanisms for end-users to load executable code or dangerous config. Of
				course, developers have full control to shoot their own feet, and Node is currently the only
				supported way to use Zzz. Deno is planned.
				<ul>
					<li>
						we'll develop a plugin API so people can make reusable integrations, and distribution
						will be through npm/jsr, decentralized like a typical open source web ecosystem project
						so the risks assumed by developers are unchanged and I gatekeep nothing -- I plan to
						publish a number of <code>@fuzdev/zzz_*</code> packages, and if people think it's worth their
						time to make Zzz things, they can publish according to their taste and devs can vet their
						code
					</li>
					<li>
						any modules you install from npm/jsr, or any code you add to the src directory, carry
						the normal elevated risks associated with development and code execution -- I try to
						practice good <ExternalLink href="https://github.com/fuzdev/fuz_template/issues/1"
							>dependency hygiene</ExternalLink
						>
					</li>
				</ul>
			</li>
			<li>
				In 2025, LLMs have serious vulnerabilities to attacks like <ExternalLink
					href="https://wikipedia.org/wiki/Prompt_injection">prompt injection</ExternalLink
				>, where they are unable to reliably discern instructions intended by the prompter from
				adversarial instructions in the data. It's unclear if this is fixable but people are
				definitely building sensitive systems with probabilistic components, and I don't want to see
				Zzz, an AI UI, make dumb predictable errors with LLMs or be designed to encourage us to make
				them. MCP's utility is high, but it can be used in <ExternalLink
					href="https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/"
					title="Simon Willison's Weblog: The lethal trifecta for AI agents: private data, untrusted content, and external communication"
					>insecure ways</ExternalLink
				> that I want to account for before integrating. Zzz will integrate LLMs into its own functionality
				slowly and carefully -- currently the only in-app LLM integration is using a local model to name
				new chats. There will be more, and we'll make sure you always have visibility into and control
				over this behavior. (for example see the
				<a href={resolve('/providers/ollama')}>Ollama controls</a>)
			</li>
			<li>
				Security and privacy should be the expected default, so for example Zzz won't make calls to
				external providers without explicit configuration. No other third party services are used.
			</li>
			<li>
				I prioritize security but it's not my expertise and I will make mistakes, help is always
				appreciated.
			</li>
		</ul>
	</section>
	<hr />
	<EcosystemLinksPanel />
	<hr />
	<section>
		<Details>
			{#snippet summary()}package details{/snippet}
			<div class="panel p_md width_atmost_md">
				<LibraryDetail {library} />
			</div>
		</Details>
	</section>
	<PageFooter />
</div>
