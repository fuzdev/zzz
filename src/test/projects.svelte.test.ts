// @vitest-environment jsdom

import { test, describe, assert, vi } from 'vitest';

import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import { Frontend } from '$lib/frontend.svelte.ts';

const page_state = vi.hoisted(() => ({
	page: { params: {} as Record<string, string>, url: new URL('http://localhost/projects') }
}));
vi.mock('$app/state', () => page_state);

const { Projects } = await import('$routes/projects/projects.svelte.ts');

describe('Projects.current_repo_id', () => {
	test('an invalid `repo_id` param means no repo instead of a throw', () => {
		page_state.page.params = { repo_id: 'not-a-uuid' };
		const projects = new Projects({ app: new Frontend() });
		assert.strictEqual(projects.current_repo_id, null);
	});

	test('a valid `repo_id` param parses', () => {
		const repo_id = create_uuid();
		page_state.page.params = { repo_id };
		const projects = new Projects({ app: new Frontend() });
		assert.strictEqual(projects.current_repo_id, repo_id);
	});
});
