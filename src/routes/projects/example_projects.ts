import {create_uuid} from '@fuzdev/fuz_util/id.js';

import type {Frontend} from '$lib/frontend.svelte.js';
import {Project} from '$routes/projects/project.svelte.js';

export const create_sample_projects = (app: Frontend): Array<Project> => {
	return [
		new Project({
			app,
			json: {
				id: create_uuid(),
				name: 'Zzz',
				description: 'web environment 💤 nice web things for the tired',
				created: '2023-01-15T12:00:00Z',
				updated: '2023-04-20T15:30:00Z',
				domains: [
					{
						id: create_uuid(),
						name: 'zzz.software',
						status: 'active',
						ssl: true,
						created: '2023-01-15T12:00:00Z',
						updated: '2023-04-20T15:30:00Z',
					},
					{
						id: create_uuid(),
						name: 'zzz.zzz.software',
						status: 'active',
						ssl: true,
						created: '2023-01-15T12:00:00Z',
						updated: '2023-04-20T15:30:00Z',
					},
				],
				pages: [
					{
						id: create_uuid(),
						path: '/',
						title: 'home',
						content: '# Welcome to Zzz\n\nZzz is both a browser and editor for the read-write web.',
						created: '2023-01-15T12:05:00Z',
						updated: '2023-01-16T09:30:00Z',
					},
					{
						id: create_uuid(),
						path: '/about',
						title: 'about',
						content:
							'# About Zzz\n\nZzz is a project that aims to make managing websites routine and easy.',
						created: '2023-01-15T14:20:00Z',
						updated: '2023-02-01T11:15:00Z',
					},
				],
				repos: [
					{
						id: create_uuid(),
						git_url: 'https://github.com/fuzdev/zzz.git',
						checkouts: [
							{
								id: create_uuid(),
								path: './zzz/',
								label: 'development',
								tags: ['main', 'dev'],
							},
						],
						created: '2023-01-15T12:05:00Z',
						updated: '2023-01-16T09:30:00Z',
					},
				],
			},
		}),
		new Project({
			app,
			json: {
				id: create_uuid(),
				name: 'Dealt',
				description: 'toy 2D web game engine with a focus on topdown action RPGs 🔮',
				created: '2023-02-10T09:15:00Z',
				updated: '2023-03-05T16:45:00Z',
				domains: [
					{
						id: create_uuid(),
						name: 'dealt.dev',
						status: 'active',
						ssl: true,
						created: '2023-02-10T09:15:00Z',
						updated: '2023-03-05T16:45:00Z',
					},
					{
						id: create_uuid(),
						name: 'tarot.dealt.dev',
						status: 'active',
						ssl: true,
						created: '2023-02-10T09:15:00Z',
						updated: '2023-03-05T16:45:00Z',
					},
				],
				pages: [
					{
						id: create_uuid(),
						path: '/',
						title: 'Dealt',
						content:
							'# Dealt\n\ntoy 2D web game engine with a focus on topdown action RPGs 🔮 <a href="https://www.dealt.dev/">dealt.dev</a>',
						created: '2023-02-10T10:00:00Z',
						updated: '2023-03-01T14:20:00Z',
					},
					{
						id: create_uuid(),
						path: '/tarot',
						title: 'Dealt: tarot',
						content:
							'# Tarot\n\ngiving meaning a chance 🔮 <a href="https://tarot.dealt.dev/">tarot.dealt.dev</a>',
						created: '2023-02-11T11:30:00Z',
						updated: '2023-02-15T09:45:00Z',
					},
				],
				repos: [
					{
						id: create_uuid(),
						git_url: 'https://github.com/ryanatkn/dealt.git',
						checkouts: [
							{
								id: create_uuid(),
								path: './dealt/',
								label: 'development',
								tags: ['main', 'dev'],
							},
							{
								id: create_uuid(),
								path: './dealt_prod/',
								label: 'production',
								tags: ['deploy', 'prod'],
							},
						],
						created: '2023-02-10T10:00:00Z',
						updated: '2023-03-01T14:20:00Z',
					},
				],
			},
		}),
		new Project({
			app,
			json: {
				id: create_uuid(),
				name: 'cosmicplayground',
				description: 'tools and toys for expanding minds 🌌',
				created: '2023-05-15T08:00:00Z',
				updated: '2023-06-20T14:15:00Z',
				domains: [
					{
						id: create_uuid(),
						name: 'cosmicplayground.org',
						status: 'active',
						ssl: true,
						created: '2023-05-15T08:00:00Z',
						updated: '2023-06-20T14:15:00Z',
					},
				],
				pages: [],
				repos: [],
			},
		}),
	];
};
