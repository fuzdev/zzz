import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extract_css_classes } from '@fuzdev/fuz_css/css_class_extractor.ts';
import { css_class_definitions } from '@fuzdev/fuz_css/css_class_definitions.ts';
import { generate_classes_css } from '@fuzdev/fuz_css/css_class_generation.ts';
import { css_class_interpreters } from '@fuzdev/fuz_css/css_class_interpreters.ts';
import { default_fs_deps } from '@fuzdev/fuz_css/deps_defaults.ts';
import { load_style_rule_index } from '@fuzdev/fuz_css/style_rule_parser.ts';
import { parse, type AST } from 'svelte/compiler';
import { test, describe, assert } from 'vitest';

const FUZ_TERMINAL_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../lib/fuz_terminal/FuzTerminal.svelte'
);

/** Every class selector in a parsed `<style>` block, found by walking its AST. */
const collect_class_selectors = (node: unknown, names: Set<string>): Set<string> => {
	if (Array.isArray(node)) {
		for (const child of node) collect_class_selectors(child, names);
	} else if (node !== null && typeof node === 'object') {
		const record = node as Record<string, unknown>;
		if (record.type === 'ClassSelector' && typeof record.name === 'string') {
			names.add(record.name);
		}
		for (const [key, value] of Object.entries(record)) {
			if (key !== 'parent') collect_class_selectors(value, names);
		}
	}
	return names;
};

interface FuzTerminalClasses {
	/** What fuz_css's extractor finds in the markup: what decides the app's utilities. */
	markup: Set<string>;
	/** What the `<style>` block styles, the runtime-built classes (`cursor-${shape}`) included. */
	styled: Set<string>;
	css: AST.CSS.StyleSheet;
}

/** The classes `FuzTerminal.svelte` renders, from its markup and its own `<style>` block. */
const load_fuz_terminal_classes = async (): Promise<FuzTerminalClasses> => {
	const source = await readFile(FUZ_TERMINAL_PATH, 'utf8');
	const markup = extract_css_classes(source, { filename: FUZ_TERMINAL_PATH });
	assert.ok(markup, 'fuz_css extracted no classes from the markup');
	const { css } = parse(source, { modern: true });
	assert.ok(css, 'the component has no `<style>` block');
	return { markup, styled: collect_class_selectors(css, new Set()), css };
};

/** The declarations of the top-level rules whose whole selector is `.${name}`. */
const to_class_rule_declarations = (css: AST.CSS.StyleSheet, name: string): Map<string, string> => {
	const declarations: Map<string, string> = new Map();
	for (const rule of css.children) {
		if (rule.type !== 'Rule') continue;
		const [complex, ...other_complex] = rule.prelude.children;
		const [relative, ...other_relative] = complex?.children ?? [];
		const [simple, ...other_simple] = relative?.selectors ?? [];
		if (other_complex.length || other_relative.length || other_simple.length) continue;
		if (simple?.type !== 'ClassSelector' || simple.name !== name) continue;
		for (const node of rule.block.children) {
			if (node.type === 'Declaration') declarations.set(node.property, node.value);
		}
	}
	return declarations;
};

describe('FuzTerminal classes', () => {
	// a component-local class that fuz_css also defines gets the utility's
	// declarations too: `grid` and `row` made the screen a grid and each row a
	// flex box, drifting the rows from the cursor and splitting a row's copy
	test('no class the component renders is a fuz_css utility or base-style class', async () => {
		const { markup, styled } = await load_fuz_terminal_classes();
		const names = new Set([...markup, ...styled]);
		const base = await load_style_rule_index(default_fs_deps);
		for (const name of names) {
			const { css } = generate_classes_css({
				class_names: [name],
				class_definitions: css_class_definitions,
				interpreters: css_class_interpreters,
				css_properties: null
			});
			assert.strictEqual(css, '', `fuz_css generates a utility for \`${name}\``);
			assert.isFalse(base.by_class.has(name), `fuz_css's base styles target \`${name}\``);
		}
		// each source found what it should: the extractor the markup's classes, the
		// walk the runtime-built ones, so neither passes on the other's names
		for (const expected of ['fuz-terminal', 'fuz-terminal-screen', 'fuz-terminal-row', 'run']) {
			assert.isTrue(markup.has(expected), expected);
		}
		assert.isTrue(markup.has('cursor-blinking'));
		assert.isTrue(styled.has('cursor-block'));
	});

	// the component's unlayered rules outrank fuz_css's layered ones, so its own
	// `display` holds whatever a global class adds
	test('the screen and its rows set their own display', async () => {
		const { css } = await load_fuz_terminal_classes();
		for (const name of ['fuz-terminal-screen', 'fuz-terminal-row']) {
			assert.strictEqual(to_class_rule_declarations(css, name).get('display'), 'block', name);
		}
	});

	test('the check sees a colliding name', () => {
		for (const name of ['grid', 'row']) {
			const { css } = generate_classes_css({
				class_names: [name],
				class_definitions: css_class_definitions,
				interpreters: css_class_interpreters,
				css_properties: null
			});
			assert.notStrictEqual(css, '', name);
		}
	});
});
