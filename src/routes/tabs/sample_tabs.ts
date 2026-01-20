import {create_uuid, get_datetime_now} from '$lib/zod_helpers.js';
import type {BrowserTabJson} from '$routes/tabs/browser_tab.svelte.js';

// Fake site content for embedded HTML tabs
export const fake_sites = {
	new_tab: {
		title: 'new tab',
		url: '/newtab',
		content: `
			<div style="padding: 20px; font-family: system-ui;">
				<h1>new tab</h1>
				<ul>
					<li><a href="https://www.zzz.software/about" target="_blank" rel="noopener">about Zzz</a></li>
					<li><a href="https://github.com/fuzdev/zzz" target="_blank" rel="noopener">source code</a></li>
				</ul>
			</div>
		`,
	},
};

// Sample tabs for browser initialization
const created = get_datetime_now();
export const sample_tabs: Array<BrowserTabJson> = [
	{
		id: create_uuid(),
		title: 'Zzz is a browser',
		url: 'https://www.zzz.software/tabs',
		type: 'raw',
		selected: true,
		refresh_counter: 0,
		created,
		updated: created,
	},
	{
		id: create_uuid(),
		title: 'fuz_css',
		selected: false,
		url: 'https://css.fuz.dev/',
		type: 'external_url',
		refresh_counter: 0,
		created,
		updated: created,
	},
	{
		id: create_uuid(),
		title: 'fuz_ui',
		selected: false,
		url: 'https://ui.fuz.dev/',
		type: 'external_url',
		refresh_counter: 0,
		created,
		updated: created,
	},
];
