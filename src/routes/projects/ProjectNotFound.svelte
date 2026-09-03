<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	import { projects_context } from './projects.svelte.ts';

	const projects = projects_context.get();
</script>

<!-- TODO have a contextmenu entry up the tree for a project that isn't found, but the id is present -->
<div class="p_lg">
	<p>
		project not found,
		<button
			type="button"
			class="inline palette_d"
			onclick={() => {
				const project = projects.create_new_project();
				void goto(resolve(`/projects/${project.id}`));
			}}
		>
			create one
		</button>?
	</p>
</div>
