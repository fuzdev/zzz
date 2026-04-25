import {z} from 'zod';
import {Uuid} from '@fuzdev/fuz_util/id.js';

import {CellJson} from '$lib/cell_types.js';

export const DomainJson = CellJson.extend({
	name: z.string().default(''),
	status: z.enum(['active', 'pending', 'inactive']).default('pending'),
	ssl: z.boolean().default(false),
}).meta({cell_class_name: 'Domain'});
export type DomainJson = z.infer<typeof DomainJson>;
export type DomainJsonInput = z.input<typeof DomainJson>;

export const PageJson = CellJson.extend({
	path: z.string().default('/'),
	title: z.string().default('New page'),
	content: z.string().default('# New page\n\nAdd your **content** here.'),
}).meta({cell_class_name: 'Page'});
export type PageJson = z.infer<typeof PageJson>;
export type PageJsonInput = z.input<typeof PageJson>;

export const RepoCheckout = z.strictObject({
	id: Uuid,
	path: z.string(),
	label: z.string(),
	tags: z.array(z.string()),
});
export type RepoCheckout = z.infer<typeof RepoCheckout>;

export const RepoJson = CellJson.extend({
	git_url: z.string(),
	checkouts: z.array(RepoCheckout).default([]),
}).meta({cell_class_name: 'Repo'});
export type RepoJson = z.infer<typeof RepoJson>;
export type RepoJsonInput = z.input<typeof RepoJson>;

export const ProjectJson = CellJson.extend({
	name: z.string().default('new project'),
	description: z.string().default(''),
	pages: z.array(PageJson).default(() => []),
	domains: z.array(DomainJson).default(() => []),
	repos: z.array(RepoJson).default([]),
}).meta({cell_class_name: 'Project'});
export type ProjectJson = z.infer<typeof ProjectJson>;
export type ProjectJsonInput = z.input<typeof ProjectJson>;

export const ProjectsJson = CellJson.extend({
	projects: z.array(ProjectJson).default(() => []),
	current_project_id: Uuid.nullable().default(null),
	current_page_id: Uuid.nullable().default(null),
	current_domain_id: Uuid.nullable().default(null),
	expanded_projects: z.record(z.string(), z.boolean()).default({}),
	previewing: z.boolean().default(false),
}).meta({cell_class_name: 'Projects'});
export type ProjectsJson = z.infer<typeof ProjectsJson>;
export type ProjectsJsonInput = z.input<typeof ProjectsJson>;
