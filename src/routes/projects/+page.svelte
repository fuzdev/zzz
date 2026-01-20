<script lang="ts">
	import {resolve} from '$app/paths';

	import {GLYPH_PROJECT} from '$lib/glyphs.js';
	import Glyph from '$lib/Glyph.svelte';
	import ProjectList from '$routes/projects/ProjectList.svelte';
	import ProjectSidebar from '$routes/projects/ProjectSidebar.svelte';
	import {projects_context} from '$routes/projects/projects.svelte.js';

	const projects = projects_context.get();
</script>

{#if projects.previewing}
	<div class="display:flex">
		<ProjectSidebar />
		<main class="flex:1 p_md overflow:auto">
			{@render content()}
			<ProjectList />
		</main>
	</div>
{:else}
	<div class="p_lg">
		{@render content()}
	</div>
{/if}

{#snippet content()}
	<h1><Glyph glyph={GLYPH_PROJECT} /> projects</h1>

	<section class="width_atmost_md">
		<p>
			When it's ready, Zzz will let you both <a href={resolve('/tabs')}>browse websites</a> and also create
			them. The goal of this "projects" design is a streamlined extensible UX with one take on building
			for the web, with integrated CMS and IDE features. This abstraction makes rough sense for my workflows,
			but it's going to change as it develops.
		</p>
		<p>
			Websites are just one kind of thing that you can make in a project. A project could be a
			simple collection of documents on the filesystem, with a UX no more complex than a folder. A
			project can also have many git repos, and other things like user data, and a repo can be
			referenced by many projects.
		</p>
		<p>
			Zzz tries to give us the maximum of the web's capabilities on all of our devices with minimal
			dependencies and optional third parties. A primary goal is to make managing websites routine
			and easy, because owning your web presence should be a cinch.
		</p>
		<p>
			Try as it might to be flexible, Zzz can't be everything to everybody. But in come the open
			standardized protocols! Because it's the web, anything you make in Zzz can be used by other
			browsers and tools, and vice versa, like magic.
		</p>
		<p>
			Here's a very rough sketch of <button
				type="button"
				class="inline compact color_g"
				onclick={() => {
					projects.previewing = !projects.previewing;
				}}>what projects could look like</button
			>.
		</p>
		<p>
			For developers, Zzz is also an npm library for TypeScript/Svelte/SvelteKit that can be used to
			make websites and servers with your current workflows.
		</p>
		<p>More <a href={resolve('/about')}>about</a> Zzz.</p>
	</section>
{/snippet}
