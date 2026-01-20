<script lang="ts">
	// @slop Claude Opus 4

	import {projects_context} from '$routes/projects/projects.svelte.js';
	import ProjectSidebar from '$routes/projects/ProjectSidebar.svelte';
	import SectionSidebar from '$routes/projects/SectionSidebar.svelte';
	import DomainsSidebar from '$routes/projects/DomainsSidebar.svelte';
	import {GLYPH_DELETE} from '$lib/glyphs.js';
	import ExternalLink from '$lib/ExternalLink.svelte';
	import Glyph from '$lib/Glyph.svelte';
	import ProjectNotFound from '$routes/projects/ProjectNotFound.svelte';

	const projects = projects_context.get();

	const domains_viewmodel = $derived(projects.current_domains_viewmodel);

	const project = $derived(projects.current_project);
</script>

<div class="domain_layout">
	<!-- TODO @many refactor for better component instance stability for e.g. transitions -->
	<ProjectSidebar />
	{#if project}
		<SectionSidebar {project} section="domains" />
		<DomainsSidebar />
	{/if}

	<div class="domain_content">
		{#if project && domains_viewmodel}
			<div class="p_lg">
				<h1 class="mb_lg">edit domain</h1>

				<p>
					{#if domains_viewmodel.domain_name}
						<ExternalLink href={`https://${domains_viewmodel.domain_name}`}>
							{domains_viewmodel.domain_name}
						</ExternalLink>
					{:else}
						[no domain name]
					{/if}
				</p>

				<div class="panel p_md width_atmost_md">
					<form
						onsubmit={(e) => {
							e.preventDefault();
							domains_viewmodel.save_domain_settings();
						}}
					>
						<div class="mb_lg">
							<label>
								<h3 class="mt_0 mb_sm">domain name</h3>
								<input type="text" bind:value={domains_viewmodel.domain_name} class="width:100%" />
							</label>
							<p>enter the full domain name, like zzz.software or blog.zzz.software</p>
						</div>

						{#if domains_viewmodel.domain}
							<p>
								<small>created {new Date(domains_viewmodel.domain.created).toLocaleString()}</small>
								<br />
								<small>updated {new Date(domains_viewmodel.domain.updated).toLocaleString()}</small>
							</p>
						{/if}

						<div class="mb_lg">
							<h3 class="mt_0 mb_sm">status</h3>
							<div class="display:flex gap_xl3">
								<label class="display:flex align-items:center mb_0">
									<input
										type="radio"
										name="status"
										value="active"
										bind:group={domains_viewmodel.domain_status}
									/>
									<span class="ml_xs">active</span>
								</label>
								<label class="display:flex align-items:center mb_0">
									<input
										type="radio"
										name="status"
										value="pending"
										bind:group={domains_viewmodel.domain_status}
									/>
									<span class="ml_xs">pending</span>
								</label>
								<label class="display:flex align-items:center mb_0">
									<input
										type="radio"
										name="status"
										value="inactive"
										bind:group={domains_viewmodel.domain_status}
									/>
									<span class="ml_xs">inactive</span>
								</label>
							</div>
						</div>

						<div class="mb_md">
							<label class="display:flex align-items:center">
								<input type="checkbox" bind:checked={domains_viewmodel.ssl_enabled} />
								<span class="ml_xs">enable SSL</span>
							</label>
						</div>

						<div class="mb_lg">
							<h3 class="mb_sm">DNS</h3>
							<p class="mb_sm">TODO many things</p>

							{#if domains_viewmodel.ssl_enabled}
								<div class="mb_sm">
									<h4>SSL Verification</h4>
									<p>To complete SSL setup, add this TXT record:</p>
									<code>_zzz-verify → verify-{domains_viewmodel.domain_id || 'your-domain-id'}</code
									>
								</div>
							{/if}
						</div>

						<div class="width:100% display:flex justify-content:space-between gap_sm">
							<div>
								<button
									type="submit"
									class="color_a"
									disabled={domains_viewmodel.domain && !domains_viewmodel.has_changes}
								>
									{domains_viewmodel.domain ? 'save changes' : 'add domain'}
								</button>
							</div>

							{#if domains_viewmodel.domain}
								<button
									type="button"
									class="color_c"
									onclick={() => domains_viewmodel.remove_domain()}
								>
									<Glyph glyph={GLYPH_DELETE} />&nbsp; delete domain
								</button>
							{/if}
						</div>
					</form>
				</div>
			</div>
		{:else}
			<ProjectNotFound />
		{/if}
	</div>
</div>

<style>
	.domain_layout {
		display: flex;
		height: 100%;
		overflow: hidden;
	}

	.domain_content {
		flex: 1;
		overflow: auto;
	}
</style>
