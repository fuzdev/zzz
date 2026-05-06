// @slop Claude Opus 4

import {z} from 'zod';
import {create_context} from '@fuzdev/fuz_ui/context_helpers.js';
import {page} from '$app/state';
import {create_uuid, Uuid} from '@fuzdev/fuz_util/id.js';
import {get_datetime_now} from '@fuzdev/fuz_util/datetime.js';

import {Cell, type CellOptions} from '$lib/cell.svelte.js';
import {ProjectsJson} from '$routes/projects/projects_schema.js';
import {Project} from '$routes/projects/project.svelte.js';
import {Page} from '$routes/projects/page.svelte.js';
import {Domain} from '$routes/projects/domain.svelte.js';
import {Repo} from '$routes/projects/repo.svelte.js';
import {ProjectViewmodel} from '$routes/projects/project_viewmodel.svelte.js';
import {PageViewmodel} from '$routes/projects/page_viewmodel.svelte.js';
import {DomainViewmodel} from '$routes/projects/domain_viewmodel.svelte.js';
import {RepoViewmodel} from '$routes/projects/repo_viewmodel.svelte.js';
import {HANDLED} from '$lib/cell_helpers.js';
import {get_unique_name} from '$lib/helpers.js';
import {create_sample_projects as create_example_projects} from '$routes/projects/example_projects.js';

export const projects_context = create_context<Projects>();

export type ProjectsOptions = CellOptions<typeof ProjectsJson>;

/**
 * Manages projects, pages, and domains using Svelte 5 runes and Cell patterns.
 */
export class Projects extends Cell<typeof ProjectsJson> {
	projects: Array<Project> = $state([]);
	current_project_id: Uuid | null = $state.raw(null);
	current_page_id: Uuid | null = $state.raw(null);
	current_domain_id: Uuid | null = $state.raw(null);
	expanded_projects: Record<string, boolean> = $state({});
	previewing: boolean = $state.raw(false);

	/** Map of project name to project for checking uniqueness */
	readonly items_by_name = $derived.by(() => {
		const result: Map<string, Project> = new Map();
		for (const project of this.projects) {
			result.set(project.name, project);
		}
		return result;
	});

	/** Current page route matches from $app/state */
	readonly page_matches = $derived(page);

	/** Current project derived from current_project_id. */
	readonly current_project = $derived(
		this.projects.find((p) => p.id === this.current_project_id) || null,
	);

	/** Current page derived from current_project and current_page_id. */
	readonly current_page = $derived(
		this.current_project?.pages.find((p) => p.id === this.current_page_id) || null,
	);

	/** Current domain derived from current_project and current_domain_id. */
	readonly current_domain = $derived(
		this.current_project?.domains.find((d) => d.id === this.current_domain_id) || null,
	);

	readonly current_repo_id = $derived.by(() => {
		const repo_id = this.page_matches.params.repo_id;
		return repo_id ? Uuid.parse(repo_id) : null;
	});

	readonly current_repo = $derived.by(() => {
		return this.current_project?.repos.find((r) => r.id === this.current_repo_id) || null;
	});

	readonly current_repos_viewmodel = $derived.by(() => {
		if (!this.current_project_id) return null;
		return new RepoViewmodel({
			projects: this,
			project_id: this.current_project_id,
			repo_id: this.current_repo_id,
		});
	});

	/** Cache of project viewmodels. */
	#project_viewmodels: Map<string, ProjectViewmodel> = new Map();

	/** Cache of page editors. */
	#page_viewmodels: Map<string, PageViewmodel> = new Map();

	/** Cache of domain viewmodels. */
	#domain_viewmodels: Map<string, DomainViewmodel> = new Map();

	/** Current project viewmodel derived from current_project_id. */
	readonly current_project_viewmodel = $derived.by(() => {
		if (!this.current_project_id) return null;

		let viewmodel = this.#project_viewmodels.get(this.current_project_id);
		if (!viewmodel) {
			viewmodel = new ProjectViewmodel({
				projects: this,
				project_id: this.current_project_id,
			});
			this.#project_viewmodels.set(this.current_project_id, viewmodel);
		}
		return viewmodel;
	});

	/** Current page editor derived from current project and page ids. */
	readonly current_page_viewmodel = $derived.by(() => {
		if (!this.current_project_id || !this.current_page_id) return null;

		const key = `${this.current_project_id}_${this.current_page_id}`;
		let viewmodel = this.#page_viewmodels.get(key);
		if (!viewmodel) {
			viewmodel = new PageViewmodel({
				projects: this,
				project_id: this.current_project_id,
				page_id: this.current_page_id,
			});
			this.#page_viewmodels.set(key, viewmodel);
		}
		return viewmodel;
	});

	/** Current domains viewmodel derived from current project and domain ids. */
	readonly current_domains_viewmodel = $derived.by(() => {
		if (!this.current_project_id) return null;

		if (!this.current_domain_id) {
			console.error('TODO ? current_domain_id is null'); // TODO looks weird
		}
		const key = `${this.current_project_id}_${this.current_domain_id || 'new'}`;
		let viewmodel = this.#domain_viewmodels.get(key);
		if (!viewmodel) {
			viewmodel = new DomainViewmodel({
				projects: this,
				project_id: this.current_project_id,
				domain_id: this.current_domain_id,
			});
			this.#domain_viewmodels.set(key, viewmodel);
		}
		return viewmodel;
	});

	constructor(options: ProjectsOptions) {
		super(ProjectsJson, options);

		this.decoders = {
			// TODO hacky
			projects: (projects_data) => {
				if (Array.isArray(projects_data)) {
					this.projects = projects_data.map(
						(project_data) => new Project({app: this.app, json: project_data}),
					);
					return HANDLED;
				}

				// If no projects provided, initialize with sample data
				if (!projects_data || !Array.isArray(projects_data) || projects_data.length === 0) {
					this.projects = create_example_projects(this.app);
					return HANDLED;
				}

				return undefined;
			},
		};

		this.init();
	}

	/**
	 * Sets the current project id.
	 */
	set_current_project(project_id: Uuid | null): void {
		console.log(`set_current_project`, project_id);
		this.current_project_id = project_id;
	}

	/**
	 * Sets the current page id.
	 */
	set_current_page(page_id: Uuid | null): void {
		console.log(`set_current_page`, page_id);
		this.current_page_id = page_id;
	}

	/**
	 * Sets the current domain id.
	 */
	set_current_domain(domain_id: Uuid | null): void {
		console.log(`set_current_domain`, domain_id);
		this.current_domain_id = domain_id;
	}

	/**
	 * Creates a new project with default values and navigates to it.
	 */
	create_new_project(): Project {
		const base_name = 'new project';
		const name = get_unique_name(base_name, this.items_by_name);

		const id = create_uuid();
		const created = get_datetime_now();

		const new_project = new Project({
			app: this.app,
			json: {
				id,
				name,
				created,
				updated: created,
				pages: [
					{
						id: create_uuid(),
						path: '/',
						title: 'Home',
						content: '# Welcome\n\nThis is the home page of your new project.',
						created,
						updated: created,
					},
				],
			},
		});

		this.add_project(new_project);

		return new_project;
	}

	/**
	 * Toggles project expansion in the sidebar.
	 */
	toggle_project_expanded(project_id: Uuid): void {
		this.expanded_projects[project_id] = !this.expanded_projects[project_id];
	}

	/**
	 * Adds a new project.
	 */
	add_project(project: Project): void {
		this.projects.push(project);
	}

	/**
	 * Deletes a project by id.
	 */
	delete_project(project_id: Uuid): void {
		const index = this.projects.findIndex((p) => p.id === project_id);
		if (index !== -1) {
			this.projects.splice(index, 1);
		}
	}

	/**
	 * Adds a new page to a project.
	 */
	add_page(project_id: Uuid, page: Page): void {
		const project = this.projects.find((p) => p.id === project_id);
		if (!project) return;

		project.add_page(page);
	}

	/**
	 * Deletes a page from a project.
	 */
	delete_page(project_id: Uuid, page_id: Uuid): void {
		const project = this.projects.find((p) => p.id === project_id);
		if (!project) return;

		project.delete_page(page_id);
	}

	/**
	 * Adds a new domain to a project.
	 */
	add_domain(project_id: Uuid, domain: Domain): void {
		const project = this.projects.find((p) => p.id === project_id);
		if (!project) return;

		project.add_domain(domain);
	}

	/**
	 * Updates an existing domain.
	 */
	update_domain(project_id: Uuid, domain: Domain): void {
		const project = this.projects.find((p) => p.id === project_id);
		if (!project) return;

		project.update_domain(domain);
	}

	/**
	 * Deletes a domain from a project.
	 */
	delete_domain(project_id: Uuid, domain_id: Uuid): void {
		const project = this.projects.find((p) => p.id === project_id);
		if (!project) return;

		project.delete_domain(domain_id);
	}

	/**
	 * Find a project by id.
	 */
	find_project(project_id: Uuid): Project | null {
		return this.projects.find((p) => p.id === project_id) || null;
	}

	/**
	 * Saves the current state.
	 */
	save(): void {
		// Trigger persistence by updating cell
		this.updated = get_datetime_now();
	}

	/**
	 * Add a repo to a project.
	 */
	add_repo(project_id: Uuid, repo: Repo): void {
		const project = this.find_project(project_id);
		if (project) {
			project.add_repo(repo);
			this.save();
		}
	}

	/**
	 * Delete a repo from a project.
	 */
	delete_repo(project_id: Uuid, repo_id: Uuid): void {
		const project = this.find_project(project_id);
		if (project) {
			project.delete_repo(repo_id);
			this.save();
		}
	}
}

export const ProjectsSchema = z.instanceof(Projects);
