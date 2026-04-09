// @slop Claude Opus 4

import {z} from 'zod';
import {goto} from '$app/navigation';
import {resolve} from '$app/paths';

import {get_datetime_now, type Uuid} from '$lib/zod_helpers.js';
import {Domain} from '$routes/projects/domain.svelte.js';
import type {Projects} from '$routes/projects/projects.svelte.js';

export interface DomainViewmodelOptions {
	projects: Projects;
	project_id: Uuid;
	domain_id: Uuid | null;
}

/**
 * Controller for domain management functionality.
 */
export class DomainViewmodel {
	readonly projects: Projects;

	project_id: Uuid = $state.raw()!;
	domain_id: Uuid | null = $state.raw()!;

	domain_name: string = $state.raw()!;
	domain_status: 'active' | 'pending' | 'inactive' = $state.raw()!;
	ssl_enabled: boolean = $state.raw()!;

	/** Whether the form has unsaved changes. */
	readonly has_changes = $derived.by(
		() =>
			this.domain === null ||
			this.domain_name !== this.domain.name ||
			this.domain_status !== this.domain.status ||
			this.ssl_enabled !== this.domain.ssl,
	);

	/** The current project. */
	readonly project = $derived.by(() => this.projects.current_project);

	/** The domain being edited. */
	readonly domain = $derived.by(() => {
		const {domain_id} = this;
		if (!domain_id) return null;
		return this.project?.domains.find((d) => d.id === domain_id) || null;
	});

	/**
	 * Creates a new DomainViewmodel instance.
	 */
	constructor(options: DomainViewmodelOptions) {
		this.projects = options.projects;

		this.project_id = options.project_id;
		this.domain_id = options.domain_id;

		this.reset_form();
	}

	// TODO @many maybe a more generic name for these like ephemeral/mirrored/viewmodel properties?
	reset_form(): void {
		if (this.domain) {
			// Existing domain - use its values
			this.domain_name = this.domain.name;
			this.domain_status = this.domain.status;
			this.ssl_enabled = this.domain.ssl;
		} else {
			// New domain - use default values
			this.domain_name = '';
			this.domain_status = 'pending';
			this.ssl_enabled = false;
		}
	}

	/**
	 * Save domain settings.
	 */
	save_domain_settings(): void {
		if (!this.project) return;

		const now = get_datetime_now();

		if (this.domain) {
			// Update existing domain
			this.domain.name = this.domain_name;
			this.domain.status = this.domain_status;
			this.domain.ssl = this.ssl_enabled;
			this.domain.updated = now;
		} else {
			// Create new domain
			const domain = new Domain({
				app: this.projects.app,
				json: {
					name: this.domain_name,
					status: this.domain_status,
					ssl: this.ssl_enabled,
					created: now,
					updated: now,
				},
			});

			this.projects.add_domain(this.project_id, domain);
		}

		void goto(resolve(`/projects/${this.project_id}/domains`));
	}

	/**
	 * Remove a domain.
	 */
	remove_domain(): void {
		if (!this.project || !this.domain_id) return;

		// eslint-disable-next-line no-alert
		if (confirm('Are you sure you want to remove this domain? This action cannot be undone.')) {
			this.projects.delete_domain(this.project_id, this.domain_id);
			void goto(resolve(`/projects/${this.project_id}/domains`));
		}
	}
}

export const DomainViewmodelSchema = z.instanceof(DomainViewmodel);
