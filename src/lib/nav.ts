import type {SvgData} from '@fuzdev/fuz_ui/Svg.svelte';
import {resolve} from '$app/paths';
import {page} from '$app/state';

import {logo_zzz} from './logos.js';
import {
	GLYPH_CAPABILITY,
	GLYPH_CHAT,
	GLYPH_FILE,
	GLYPH_INFO,
	GLYPH_LOG,
	GLYPH_MODEL,
	GLYPH_PROMPT,
	GLYPH_PROVIDER,
	GLYPH_SETTINGS,
	GLYPH_TERMINAL,
} from './glyphs.js';
import type {Frontend} from './frontend.svelte.js';

export interface NavLinkItem {
	label: string;
	href: string;
	icon: string | SvgData;
}

// TODO fuz api for this in its library nav? look into it at the library -> docs rename
export interface NavItem {
	group: string;
	items: Array<NavLinkItem>;
}

// TODO generalize this pattern, it's one part of a hacky fix
// for the chats/prompts links to show the last selected id,
// if any, when not on the route directly.
// See also the `onNavigate` fix in the root layout for nulling out the value
// when navigating directly to the base route.
export const to_nav_link_href = (app: Frontend, label: string, href: string): string => {
	if (
		label === 'chats' &&
		app.chats.selected_id_last_non_null &&
		!(page.url.pathname === href || page.url.pathname.startsWith(href + '/'))
	) {
		return href + '/' + app.chats.selected_id_last_non_null;
	} else if (
		label === 'prompts' &&
		app.prompts.selected_id_last_non_null &&
		!(page.url.pathname === href || page.url.pathname.startsWith(href + '/'))
	) {
		return href + '/' + app.prompts.selected_id_last_non_null;
	}
	return href;
};

// TODO make this configurable
export const main_nav_items_default: Array<NavItem> = [
	{
		group: 'main',
		items: [
			{label: 'chats', href: resolve('/chats'), icon: GLYPH_CHAT},
			{label: 'prompts', href: resolve('/prompts'), icon: GLYPH_PROMPT},
			{label: 'files', href: resolve('/files'), icon: GLYPH_FILE},
			{label: 'terminals', href: resolve('/terminals'), icon: GLYPH_TERMINAL},
		],
	},
	{
		group: 'llms',
		items: [
			{label: 'models', href: resolve('/models'), icon: GLYPH_MODEL},
			{label: 'providers', href: resolve('/providers'), icon: GLYPH_PROVIDER},
		],
	},
	{
		group: 'system',
		items: [
			{label: 'about', href: resolve('/about'), icon: logo_zzz},
			{label: 'capabilities', href: resolve('/capabilities'), icon: GLYPH_CAPABILITY},
			{label: 'docs', href: resolve('/docs'), icon: GLYPH_INFO},
			{label: 'actions', href: resolve('/actions'), icon: GLYPH_LOG},
			{label: 'settings', href: resolve('/settings'), icon: GLYPH_SETTINGS},
		],
	},
];
