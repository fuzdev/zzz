<script lang="ts">
	import {resolve} from '$app/paths';
	import type {Repo} from './repo.svelte.ts';

	const {
		repo,
		project_id,
	}: {
		repo: Repo;
		project_id: string;
	} = $props();
</script>

<tr>
	<td>
		<a href={resolve(`/projects/${project_id}/repos/${repo.id}`)}>
			{repo.git_url || '[new repo]'}
		</a>
	</td>
	<td>
		{repo.checkouts.length}
	</td>
	<td>{new Date(repo.created).toLocaleString()}</td>
	<td>{new Date(repo.updated).toLocaleString()}</td>
</tr>
