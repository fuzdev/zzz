import type {SvgData} from '@fuzdev/fuz_ui/svg.ts';
import {resolve} from '$app/paths';
import {page} from '$app/state';

import {
	icon_capability,
	icon_chat,
	icon_file,
	icon_info,
	icon_log,
	icon_model,
	icon_prompt,
	icon_provider,
	icon_settings,
	icon_terminal,
	icon_workspace,
} from '@fuzdev/fuz_ui/icons.ts';

import {logo_zzz} from './logos.ts';
import type {Frontend} from './frontend.svelte.ts';

export interface NavLinkItem {
	label: string;
	href: string;
	icon: SvgData;
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
			{label: 'chats', href: resolve('/chats'), icon: icon_chat},
			{label: 'prompts', href: resolve('/prompts'), icon: icon_prompt},
			{label: 'files', href: resolve('/files'), icon: icon_file},
			{label: 'workspaces', href: resolve('/workspaces'), icon: icon_workspace},
			{label: 'terminals', href: resolve('/terminals'), icon: icon_terminal},
		],
	},
	{
		group: 'llms',
		items: [
			{label: 'models', href: resolve('/models'), icon: icon_model},
			{label: 'providers', href: resolve('/providers'), icon: icon_provider},
		],
	},
	{
		group: 'system',
		items: [
			{label: 'about', href: resolve('/about'), icon: logo_zzz},
			{label: 'capabilities', href: resolve('/capabilities'), icon: icon_capability},
			{label: 'docs', href: resolve('/docs'), icon: icon_info},
			{label: 'actions', href: resolve('/actions'), icon: icon_log},
			{label: 'settings', href: resolve('/settings'), icon: icon_settings},
		],
	},
];
