// @slop Claude Opus 4

import {z} from 'zod';
import {goto} from '$app/navigation';
import {resolve} from '$app/paths';
import {create_uuid, type Uuid} from '@fuzdev/fuz_util/id.js';
import {get_datetime_now} from '@fuzdev/fuz_util/datetime.js';

import {Domain} from '$routes/projects/domain.svelte.js';
import {Page} from '$routes/projects/page.svelte.js';
import {Projects} from '$routes/projects/projects.svelte.js';
import {Repo} from '$routes/projects/repo.svelte.js';
import {get_unique_name} from '$lib/helpers.js';

export interface ProjectViewmodelOptions {
	projects: Projects;
	project_id: Uuid;
}

/**
 * Controller for managing project details and operations.
 */
export class ProjectViewmodel {
	readonly projects: Projects;

	project_id: Uuid = $state.raw()!;

	edited_name: string = $state.raw()!;
	edited_description: string = $state.raw()!;

	editing_project: boolean = $state.raw(false);

	/** Whether the form has unsaved changes. */
	readonly has_changes = $derived.by(
		() =>
			this.project &&
			(this.edited_name !== this.project.name ||
				this.edited_description !== this.project.description),
	);

	/** The current project. */
	readonly project = $derived.by(() => this.projects.current_project);

	/**
	 * Creates a new ProjectViewmodel instance.
	 */
	constructor(options: ProjectViewmodelOptions) {
		this.projects = options.projects;

		this.project_id = options.project_id;

		this.reset_form();
	}

	// TODO @many maybe a more generic name for these like ephemeral/mirrored/viewmodel properties?
	reset_form(): void {
		if (this.project) {
			this.edited_name = this.project.name;
			this.edited_description = this.project.description;
		} else {
			this.edited_name = '';
			this.edited_description = '';
		}
	}

	/**
	 * Save edited project details.
	 */
	save_project_details(): void {
		if (!this.project) return;

		if (!this.edited_name.trim()) {
			// eslint-disable-next-line no-alert
			alert('Project name is required.');
			return;
		}

		this.project.name = this.edited_name;
		this.project.description = this.edited_description;
		this.project.updated = get_datetime_now();

		this.editing_project = false;
	}

	/**
	 * Delete the current project.
	 */
	delete_current_project(): void {
		if (!this.project) return;

		// eslint-disable-next-line no-alert
		const confirmed = confirm(
			'Are you sure you want to delete this project? This action cannot be undone.',
		);

		if (confirmed) {
			this.projects.delete_project(this.project_id);
			void goto(resolve('/projects'));
		}
	}

	/**
	 * Delete a page from the current project.
	 */
	delete_project_page(page_id: Uuid): void {
		if (!this.project) return;

		// eslint-disable-next-line no-alert
		const confirmed = confirm(
			'Are you sure you want to delete this page? This action cannot be undone.',
		);

		if (confirmed) {
			this.project.delete_page(page_id);
		}
	}

	/**
	 * Create a new blank page and navigate to it.
	 */
	create_new_page(): void {
		if (!this.project) return;

		// Generate a unique page name within this project
		const base_title = 'New page';
		const existing_titles = this.project.pages.map((p) => p.title);
		const unique_title = get_unique_name(base_title, new Set(existing_titles));

		const page_id = create_uuid();
		const created = get_datetime_now();

		const page = new Page({
			app: this.projects.app,
			json: {
				id: page_id,
				title: unique_title,
				path: '/new-page',
				content: `# ${unique_title}\n\nAdd your **content** here.`,
				created,
				updated: created,
			},
		});

		this.project.add_page(page);
		void goto(resolve(`/projects/${this.project_id}/pages/${page_id}`));
	}

	/**
	 * Create a new domain and navigate to it.
	 */
	create_new_domain(): void {
		if (!this.project) return;

		const domain_id = create_uuid();
		const created = get_datetime_now();

		const domain = new Domain({
			app: this.projects.app,
			json: {
				id: domain_id,
				created,
				updated: created,
				name: '',
				status: 'pending',
				ssl: false,
			},
		});

		this.project.add_domain(domain);
		void goto(resolve(`/projects/${this.project_id}/domains/${domain_id}`));
	}

	/**
	 * Creates a new repo and navigates to it.
	 */
	create_new_repo(): void {
		if (!this.project) return;

		const repo_id = create_uuid();

		// Create a new repo
		const repo = new Repo({
			app: this.projects.app,
			// TODO parse with schema
			json: {
				id: repo_id,
				git_url: '',
				checkouts: [],
			},
		});

		// Add to project
		this.project.add_repo(repo);

		// Navigate to the repo
		void goto(resolve(`/projects/${this.project_id}/repos/${repo_id}`));
	}
}

export const ProjectViewmodelSchema = z.instanceof(ProjectViewmodel);
