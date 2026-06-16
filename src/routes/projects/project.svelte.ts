// @slop Claude Opus 4

import {z} from 'zod';
import type {ArrayElement} from '@fuzdev/fuz_util/types.ts';
import {Uuid} from '@fuzdev/fuz_util/id.ts';
import {get_datetime_now} from '@fuzdev/fuz_util/datetime.ts';

import {Cell, type CellOptions} from '$lib/cell.svelte.ts';
import {ProjectJson} from './projects_schema.ts';
import {Domain} from './domain.svelte.ts';
import {Page} from './page.svelte.ts';
import {Repo} from './repo.svelte.ts';
import {HANDLED} from '$lib/cell_helpers.ts';

export const project_sections = ['project', 'pages', 'domains', 'repos', 'settings'] as const;
export type ProjectSection = ArrayElement<typeof project_sections>;

export type ProjectOptions = CellOptions<typeof ProjectJson>;

/**
 * Represents a project with pages and domains.
 */
export class Project extends Cell<typeof ProjectJson> {
	name: string = $state.raw()!;
	description: string = $state.raw()!;
	pages: Array<Page> = $state([]);
	domains: Array<Domain> = $state([]);
	repos: Array<Repo> = $state([]);

	constructor(options: ProjectOptions) {
		super(ProjectJson, options);

		this.decoders = {
			pages: (pages_data) => {
				if (Array.isArray(pages_data)) {
					this.pages = pages_data.map((page_data) => new Page({app: this.app, json: page_data}));
					return HANDLED;
				}
				return undefined;
			},
			domains: (domains_data) => {
				if (Array.isArray(domains_data)) {
					this.domains = domains_data.map(
						(domain_data) => new Domain({app: this.app, json: domain_data}),
					);
					return HANDLED;
				}
				return undefined;
			},
			repos: (repos_data) => {
				if (Array.isArray(repos_data)) {
					this.repos = repos_data.map((repo_data) => new Repo({app: this.app, json: repo_data}));
					return HANDLED;
				}
				return undefined;
			},
		};

		this.init();
	}

	add_page(page: Page): void {
		this.pages.push(page);
		this.updated = get_datetime_now();
	}

	update_page(page: Page): void {
		const index = this.pages.findIndex((p) => p.id === page.id);
		if (index !== -1) {
			this.pages[index] = page;
			this.updated = get_datetime_now();
		}
	}

	delete_page(page_id: Uuid): void {
		const index = this.pages.findIndex((p) => p.id === page_id);
		if (index !== -1) {
			this.pages.splice(index, 1);
			this.updated = get_datetime_now();
		}
	}

	add_domain(domain: Domain): void {
		this.domains.push(domain);
		this.updated = get_datetime_now();
	}

	update_domain(domain: Domain): void {
		const index = this.domains.findIndex((d) => d.id === domain.id);
		if (index !== -1) {
			this.domains[index] = domain;
			this.updated = get_datetime_now();
		}
	}

	delete_domain(domain_id: Uuid): void {
		const index = this.domains.findIndex((d) => d.id === domain_id);
		if (index !== -1) {
			this.domains.splice(index, 1);
			this.updated = get_datetime_now();
		}
	}

	add_repo(repo: Repo): void {
		this.repos.push(repo);
		this.updated = get_datetime_now();
	}

	update_repo(repo: Repo): void {
		const index = this.repos.findIndex((r) => r.id === repo.id);
		if (index !== -1) {
			this.repos[index] = repo;
			this.updated = get_datetime_now();
		}
	}

	delete_repo(repo_id: Uuid): void {
		const index = this.repos.findIndex((r) => r.id === repo_id);
		if (index !== -1) {
			this.repos.splice(index, 1);
			this.updated = get_datetime_now();
		}
	}
}

export const ProjectSchema = z.instanceof(Project);
