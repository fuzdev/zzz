/**
 * Shared zzz app factory.
 *
 * Creates the Hono app with Backend, AI providers, and action endpoints.
 * Called by the server entry point (`server.ts`).
 *
 * @module
 */

import {Hono} from 'hono';
import {upgradeWebSocket} from 'hono/deno';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {parse_allowed_origins, verify_request_source} from '@fuzdev/fuz_app/http/origin.js';

import {build_allowed_hostnames, create_host_validation_middleware} from './security.js';
import {Backend} from './backend.js';
import type {ZzzServerConfig} from './server_env.js';
import {backend_action_handlers} from './backend_action_handlers.js';
import {register_http_actions} from './register_http_actions.js';
import {register_websocket_actions} from './register_websocket_actions.js';
import create_config from '../config.js';
import {action_specs} from '../action_collections.js';
import {handle_filer_change} from './backend_actions_api.js';
import {BackendProviderOllama} from './backend_provider_ollama.js';
import {BackendProviderClaude} from './backend_provider_claude.js';
import {BackendProviderChatgpt} from './backend_provider_chatgpt.js';
import {BackendProviderGemini} from './backend_provider_gemini.js';
import type {BackendProviderOptions} from './backend_provider.js';

const log = new Logger('[server]');

/**
 * Options for creating a zzz app.
 */
export interface CreateZzzAppOptions {
	/** Server environment configuration. */
	env: ZzzServerConfig;
}

/**
 * The created zzz app and its backend.
 */
export interface ZzzApp {
	/** Configured Hono app with all middleware and routes. */
	app: Hono;
	/** Backend instance for lifecycle management. */
	backend: Backend;
}

/**
 * Create the zzz Hono app with Backend, providers, and endpoints.
 *
 * This is the shared factory called by the server entry point.
 */
export const create_zzz_app = (options: CreateZzzAppOptions): ZzzApp => {
	const {env} = options;

	// TODO better config
	const config = create_config();

	// Security: allow only the configured origins
	const allowed_origins = parse_allowed_origins(env.allowed_origins);

	log.info('creating server', {
		zzz_dir: env.zzz_dir,
		scoped_dirs: env.scoped_dirs,
		providers: config.providers.map((p) => p.name),
		models: config.models.length,
		allowed_origins,
	});

	const app = new Hono();

	// Logging middleware
	app.use(async (c, next) => {
		log.info(
			`[request_begin] ${c.req.method} ${c.req.url} origin(${c.req.header('origin')}) referer(${c.req.header('referer')})`,
		);
		await next();
		log.info(`[request_end] ${c.req.method} ${c.req.url}`);
	});

	// Security: validate Host header (DNS rebinding defense-in-depth)
	const allowed_hostnames = build_allowed_hostnames(env.host);
	app.use(create_host_validation_middleware(allowed_hostnames));

	// Security: verify origin of incoming requests.
	// This runs for ALL routes including WebSocket upgrade (GET /ws).
	// Browsers always send Origin on WebSocket upgrades (spec-enforced),
	// so malicious pages cannot connect — their origin won't match.
	app.use(verify_request_source(allowed_origins));

	const backend = new Backend({
		zzz_dir: env.zzz_dir,
		scoped_dirs: env.scoped_dirs.length > 0 ? env.scoped_dirs : undefined,
		config,
		action_specs,
		action_handlers: backend_action_handlers,
		handle_filer_change,
	});

	// Register AI providers
	const provider_options: BackendProviderOptions = {
		on_completion_progress: backend.api.completion_progress,
	};
	backend.add_provider(new BackendProviderOllama(provider_options));
	backend.add_provider(
		new BackendProviderClaude({
			...provider_options,
			api_key: env.secret_anthropic_api_key ?? null,
		}),
	);
	backend.add_provider(
		new BackendProviderChatgpt({
			...provider_options,
			api_key: env.secret_openai_api_key ?? null,
		}),
	);
	backend.add_provider(
		new BackendProviderGemini({
			...provider_options,
			api_key: env.secret_google_api_key ?? null,
		}),
	);

	// Register WebSocket endpoint
	if (env.websocket_path) {
		register_websocket_actions({
			path: env.websocket_path,
			app,
			backend,
			upgradeWebSocket,
			artificial_delay: env.artificial_delay,
		});
	}

	// Register HTTP RPC endpoint
	if (env.api_path) {
		register_http_actions({
			path: env.api_path,
			app,
			backend,
			artificial_delay: env.artificial_delay,
		});
	}

	return {app, backend};
};
