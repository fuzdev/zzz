import type { Frontend } from '#lib/frontend.svelte.ts';
import type { DiskfilePath } from '#lib/diskfile_types.ts';

// TODO improve this pattern
/**
 * Applies testing-specific modifications to a Zzz instance.
 */
export const monkeypatch_zzz_for_tests = <T extends Frontend>(app: T): T => {
	// Override diskfiles.update to be synchronous.
	// In the real implementation, this would make a server request.
	// Probably want to mock differently than this but it's fine for now.
	app.diskfiles.update = (path: DiskfilePath, content: string) => {
		const diskfile = app.diskfiles.get_by_path(path);
		if (diskfile) {
			diskfile.content = content;
		}
		return Promise.resolve({ ok: true, value: null });
	};

	return app;
};

/**
 * An element's text as a browser names it, which jsdom can't: without the subtrees
 * hidden by `aria-hidden` or an inline `visibility: hidden` (`ToggleButton`'s
 * sizing copies of its labels), whitespace collapsed.
 */
export const to_visible_text = (el: Element): string => {
	const parts: Array<string> = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			parts.push(node.textContent ?? '');
			return;
		}
		if (!(node instanceof HTMLElement)) return;
		if (node.getAttribute('aria-hidden') === 'true' || node.style.visibility === 'hidden') return;
		for (const child of node.childNodes) walk(child);
	};
	walk(el);
	return parts.join('').replace(/\s+/g, ' ').trim();
};

// Test helpers for unit tests
