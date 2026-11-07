import { string, with_default } from '@fuzdev/fuz_schema/schema.ts';
import { get_schema_entries } from '@fuzdev/fuz_schema/introspect.ts';
import { get_meta } from '@fuzdev/fuz_schema/meta.ts';
import { test, assert } from 'vitest';

import { CellJson, cell_json_schema } from '#lib/cell_types.ts';

test('cell_json_schema puts `CellJson` first, an override in its place, and names the class', () => {
	const name = with_default(string, '');
	const updated = with_default(string, 'never');
	const schema = cell_json_schema({ name, updated }, 'Thing');

	const entries = get_schema_entries(schema)!;
	assert.deepEqual(Object.keys(entries), ['id', 'created', 'updated', 'name']);
	assert.strictEqual(entries.id, CellJson.def.id);
	assert.strictEqual(entries.updated, updated);
	assert.strictEqual(entries.name, name);
	assert.strictEqual(get_meta(schema)?.cell_class_name, 'Thing');
});
