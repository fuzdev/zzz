// @vitest-environment jsdom

import { describe, test, assert, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { icon_add } from '@fuzdev/fuz_ui/icons.ts';

import Icon from '$lib/Icon.svelte';

let cleanup: (() => void) | null = null;
afterEach(() => {
	cleanup?.();
	cleanup = null;
});

const mount_icon = (props: Record<string, unknown> = {}): SVGSVGElement => {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(Icon, { target, props: { data: icon_add, ...props } });
	flushSync();
	cleanup = () => {
		void unmount(component);
		target.remove();
	};
	const svg = target.querySelector('svg');
	assert.ok(svg);
	return svg;
};

describe('Icon', () => {
	test('defaults to a text-sized, inline, unshrinkable icon', () => {
		const svg = mount_icon();
		assert.strictEqual(svg.style.width, '1em');
		assert.strictEqual(svg.style.height, '1em');
		assert.strictEqual(svg.style.flexShrink, '0');
		assert.strictEqual(svg.style.maxWidth, 'none');
		assert.ok(svg.classList.contains('inline'));
	});

	test('props override the defaults and a style merges', () => {
		const svg = mount_icon({ size: '2em', inline: false, shrink: true, style: 'opacity: 0.5' });
		assert.strictEqual(svg.style.width, '2em');
		assert.strictEqual(svg.style.flexShrink, '1');
		assert.strictEqual(svg.style.maxWidth, 'none');
		assert.strictEqual(svg.style.opacity, '0.5');
		assert.ok(!svg.classList.contains('inline'));
	});
});
