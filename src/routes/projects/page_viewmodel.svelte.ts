// @slop Claude Opus 4

import {z} from 'zod';
import {goto} from '$app/navigation';

import {get_datetime_now, type Uuid} from '$lib/zod_helpers.js';
import {Page} from '$routes/projects/page.svelte.js';
import type {Projects} from '$routes/projects/projects.svelte.js';
import {resolve} from '$app/paths';

export interface PageViewmodelOptions {
	projects: Projects;
	project_id: Uuid;
	page_id: Uuid;
}

/**
 * Simple sanitization function to prevent XSS attacks.
 * This is a basic implementation and should be replaced with a proper sanitization library in production.
 */
const sanitize_html = (html: string): string => {
	// Remove script tags and inline event handlers
	return html
		.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
		.replace(/on\w+="[^"]*"/gi, '')
		.replace(/on\w+='[^']*'/gi, '')
		.replace(/on\w+=\S+/gi, '');
};

/**
 * Simple markdown parser for basic formatting.
 */
const render_markdown = (text: string): string => {
	// Split content by double newlines to identify paragraphs
	const paragraphs = text.split(/\n\n+/);

	// Process each paragraph
	const formatted = paragraphs
		.map((paragraph) => {
			// Trim the paragraph
			let p = paragraph.trim();
			if (!p) return '';

			// Basic heading detection
			if (p.startsWith('# ')) {
				return `<h1>${sanitize_html(p.substring(2))}</h1>`;
			} else if (p.startsWith('## ')) {
				return `<h2>${sanitize_html(p.substring(3))}</h2>`;
			} else if (p.startsWith('### ')) {
				return `<h3>${sanitize_html(p.substring(4))}</h3>`;
			}

			// Basic list detection
			if (p.includes('\n- ')) {
				const items = p.split('\n- ');
				const list_items = items
					.slice(1)
					.map((item) => `<li>${sanitize_html(item)}</li>`)
					.join('');

				const first_item = items[0];
				if (!first_item || first_item.trim() === '') {
					return `<ul>${list_items}</ul>`;
				} else {
					return `<p>${sanitize_html(first_item)}</p><ul>${list_items}</ul>`;
				}
			}

			// Bold text
			p = p.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

			// Italic text
			p = p.replace(/\*(.*?)\*/g, '<em>$1</em>');

			// Regular paragraph
			return `<p>${sanitize_html(p)}</p>`;
		})
		.join('');

	return formatted;
};

/**
 * Manages page editor functionality.
 */
export class PageViewmodel {
	readonly projects: Projects;

	project_id: Uuid = $state.raw()!;
	page_id: Uuid = $state.raw()!;

	title: string = $state.raw()!;
	path: string = $state.raw()!;
	content: string = $state.raw()!;

	/** Whether the form has unsaved changes. */
	readonly has_changes = $derived.by(
		() =>
			this.current_page &&
			(this.title !== this.current_page.title ||
				this.path !== this.current_page.path ||
				this.content !== this.current_page.content),
	);

	/** The current project. */
	readonly project = $derived.by(() => this.projects.current_project);

	/** The current page. */
	readonly current_page = $derived.by(() => {
		const {page_id} = this;
		return this.project?.pages.find((p) => p.id === page_id) || null;
	});

	/** Safely formatted content for preview. */
	readonly formatted_content = $derived(render_markdown(this.content));

	/**
	 * Creates a new PageViewmodel instance.
	 */
	constructor(options: PageViewmodelOptions) {
		this.projects = options.projects;

		this.project_id = options.project_id;
		this.page_id = options.page_id;

		this.reset_form();
	}

	// TODO @many maybe a more generic name for these like ephemeral/mirrored/viewmodel properties?
	reset_form(): void {
		if (this.current_page) {
			this.title = this.current_page.title;
			this.path = this.current_page.path;
			this.content = this.current_page.content;
		} else {
			this.title = 'New page';
			this.path = '/';
			this.content = '# New page\n\nYour content goes here.';
		}
	}

	/**
	 * Save the current page.
	 */
	save_page(): void {
		if (!this.project) return;

		if (!this.title.trim() || !this.path.trim()) {
			// eslint-disable-next-line no-alert
			alert('Title and path are required.');
			return;
		}

		// Ensure path starts with /
		const formatted_path = this.path.startsWith('/') ? this.path : `/${this.path}`;
		const now = get_datetime_now();

		let page = this.current_page;

		if (!page) {
			// Create new page
			page = new Page({
				app: this.projects.app,
				json: {
					title: this.title,
					path: formatted_path,
					content: this.content,
					created: now,
					updated: now,
				},
			});

			this.projects.add_page(this.project_id, page);
		} else if (this.current_page) {
			// Update existing page
			this.current_page.title = this.title;
			this.current_page.path = formatted_path;
			this.current_page.content = this.content;
			this.current_page.updated = now;
		}

		void goto(resolve(`/projects/${this.project_id}/pages`));
	}
}

export const PageViewmodelSchema = z.instanceof(PageViewmodel);
