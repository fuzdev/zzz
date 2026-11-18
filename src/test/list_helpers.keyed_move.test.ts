import { test, describe, assert } from 'vitest';

import { to_keyed_move, to_reordered_list } from '#lib/list_helpers.ts';

/** Applies a keyed move: the key out, then in front of `before` (or at the end). */
const apply = <T>(keys: Array<T>, move: { key: T; before: T | null }): Array<T> => {
	const rest = keys.filter((k) => k !== move.key);
	const index = move.before === null ? rest.length : rest.indexOf(move.before);
	rest.splice(index, 0, move.key);
	return rest;
};

describe('to_keyed_move', () => {
	test('agrees with `to_reordered_list` for every move within the list', () => {
		for (let length = 1; length <= 6; length++) {
			const keys = Array.from({ length }, (_, i) => `k${i}`);
			for (let from = 0; from < length; from++) {
				for (let to = 0; to < length; to++) {
					const move = to_keyed_move(keys, from, to);
					if (from === to) {
						assert.isNull(move, `${length}: ${from}→${to}`);
						continue;
					}
					assert.ok(move, `${length}: ${from}→${to}`);
					assert.deepEqual(
						apply(keys, move),
						to_reordered_list(keys, from, to),
						`${length}: ${from}→${to}`
					);
				}
			}
		}
	});

	test('refuses indices outside the list', () => {
		const keys = ['a', 'b', 'c'];
		assert.isNull(to_keyed_move(keys, -1, 0));
		assert.isNull(to_keyed_move(keys, 0, 3));
		assert.isNull(to_keyed_move(keys, 3, 0));
	});
});
