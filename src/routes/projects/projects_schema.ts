import {
	array,
	boolean,
	nullable,
	object,
	one_of,
	record,
	string,
	with_default,
	with_default_fn,
	type Infer,
	type InferInput
} from '@fuzdev/fuz_schema/schema.ts';
import { Uuid } from '@fuzdev/fuz_app/primitive_schemas.ts';

import { cell_json_schema } from '#lib/cell_types.ts';

export const DomainJson = cell_json_schema(
	{
		name: with_default(string, ''),
		status: with_default(one_of(['active', 'pending', 'inactive']), 'pending'),
		ssl: with_default(boolean, false)
	},
	'Domain'
);
export type DomainJson = Infer<typeof DomainJson>;
export type DomainJsonInput = InferInput<typeof DomainJson>;

export const PageJson = cell_json_schema(
	{
		path: with_default(string, '/'),
		title: with_default(string, 'New page'),
		content: with_default(string, '# New page\n\nAdd your **content** here.')
	},
	'Page'
);
export type PageJson = Infer<typeof PageJson>;
export type PageJsonInput = InferInput<typeof PageJson>;

export const RepoCheckout = object({
	id: Uuid,
	path: string,
	label: string,
	tags: array(string)
});
export type RepoCheckout = Infer<typeof RepoCheckout>;

export const RepoJson = cell_json_schema(
	{
		git_url: string,
		checkouts: with_default_fn(array(RepoCheckout), () => [])
	},
	'Repo'
);
export type RepoJson = Infer<typeof RepoJson>;
export type RepoJsonInput = InferInput<typeof RepoJson>;

export const ProjectJson = cell_json_schema(
	{
		name: with_default(string, 'new project'),
		description: with_default(string, ''),
		pages: with_default_fn(array(PageJson), () => []),
		domains: with_default_fn(array(DomainJson), () => []),
		repos: with_default_fn(array(RepoJson), () => [])
	},
	'Project'
);
export type ProjectJson = Infer<typeof ProjectJson>;
export type ProjectJsonInput = InferInput<typeof ProjectJson>;

export const ProjectsJson = cell_json_schema(
	{
		projects: with_default_fn(array(ProjectJson), () => []),
		current_project_id: with_default(nullable(Uuid), null),
		current_page_id: with_default(nullable(Uuid), null),
		current_domain_id: with_default(nullable(Uuid), null),
		expanded_projects: with_default_fn(record(boolean), () => ({})),
		previewing: with_default(boolean, false)
	},
	'Projects'
);
export type ProjectsJson = Infer<typeof ProjectsJson>;
export type ProjectsJsonInput = InferInput<typeof ProjectsJson>;
