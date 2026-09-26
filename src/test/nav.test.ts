import { describe, test, assert } from 'vitest';
import { create_uuid } from '@fuzdev/fuz_util/id.ts';

import { parse_url_param_uuid, to_chats_url, to_prompts_url } from '$lib/nav.ts';

describe('parse_url_param_uuid', () => {
	test('returns a valid uuid', () => {
		const id = create_uuid();
		assert.strictEqual(parse_url_param_uuid(id), id);
	});

	test('returns null for a missing or invalid value', () => {
		assert.isNull(parse_url_param_uuid(undefined));
		assert.isNull(parse_url_param_uuid(null));
		assert.isNull(parse_url_param_uuid(''));
		assert.isNull(parse_url_param_uuid('not-a-uuid'));
		assert.isNull(parse_url_param_uuid(42));
	});
});

describe('to_chats_url and to_prompts_url', () => {
	test('link to the selected item, or the base route', () => {
		const id = create_uuid();
		assert.ok(to_chats_url(id).endsWith(`/chats/${id}`));
		assert.ok(to_chats_url(null).endsWith('/chats'));
		assert.ok(to_prompts_url(id).endsWith(`/prompts/${id}`));
		assert.ok(to_prompts_url(null).endsWith('/prompts'));
	});
});
