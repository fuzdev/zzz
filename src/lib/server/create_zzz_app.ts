/**
 * Runtime-agnostic zzz app factory.
 *
 * Creates the full application by combining fuz_app's `create_app_backend`
 * and `create_app_server` with zzz's domain Backend, AI providers, and
 * WebSocket endpoint. Called by the server entry point (`server.ts`).
 *
 * @module
 */

import type {Context, Hono} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {validate_server_env} from '@fuzdev/fuz_app/server/env.js';
import {create_app_backend, type AppBackend} from '@fuzdev/fuz_app/server/app_backend.js';
import {create_app_server, type AppServer} from '@fuzdev/fuz_app/server/app_server.js';
import type {AppSurface} from '@fuzdev/fuz_app/http/surface.js';
import type {PasswordHashDeps} from '@fuzdev/fuz_app/auth/password.js';
import type {StatResult} from '@fuzdev/fuz_app/runtime/deps.js';
import type {MiddlewareSpec} from '@fuzdev/fuz_app/http/middleware_spec.js';

import {build_allowed_hostnames, create_host_validation_middleware} from './security.js';
import {Backend} from './backend.js';
import {
	ZzzServerEnv as ZzzServerEnvSchema,
	type ZzzServerConfig,
	type ZzzServerEnv,
} from './server_env.js';
import {backend_action_handlers} from './backend_action_handlers.js';
import {action_specs} from '../action_collections.js';
import {handle_filer_change} from './backend_actions_api.js';
import {BackendProviderOllama} from './backend_provider_ollama.js';
import {BackendProviderClaude} from './backend_provider_claude.js';
import {BackendProviderChatgpt} from './backend_provider_chatgpt.js';
import {BackendProviderGemini} from './backend_provider_gemini.js';
import type {BackendProviderOptions} from './backend_provider.js';
import create_config from '../config.js';
import {zzz_session_config} from './routes/account.js';
import {create_zzz_app_route_specs, create_zzz_rpc_endpoint_spec} from './zzz_route_specs.js';
import {init_zzz_schema} from './db/zzz_schema.js';

const log = new Logger('[server]');

/**
 * Options for creating a zzz app.
 */
export interface CreateZzzAppOptions {
	/** Server environment configuration. */
	config: ZzzServerConfig;
	/** Password hashing deps — `argon2_password_deps` for production, stubs for tests. */
	password: PasswordHashDeps;
	/**
	 * Runtime filesystem operations.
	 * Provided by `create_deno_runtime` or `create_node_runtime`.
	 */
	runtime: {
		stat: (path: string) => Promise<StatResult | null>;
		read_text_file: (path: string) => Promise<string>;
		remove: (path: string) => Promise<void>;
	};
	/** Extract the raw TCP connection IP from the Hono context. */
	get_connection_ip: (c: Context) => string | undefined;
}

/**
 * The created zzz app and related instances.
 */
export interface ZzzApp {
	/** Configured Hono app with all middleware and routes. */
	app: Hono;
	/** zzz domain Backend instance for lifecycle management. */
	backend: Backend;
	/** fuz_app backend for database and auth. */
	app_backend: AppBackend;
	/** Generated attack surface. */
	surface: AppSurface;
	/** Validated environment. */
	env: ZzzServerEnv;
	/** Parsed allowed origin patterns (from `validate_server_env`). */
	allowed_origins: Array<RegExp>;
	/** Close database connection. */
	close: () => Promise<void>;
}

/**
 * Create the zzz Hono app with auth, database, Backend, providers, and endpoints.
 *
 * This is the shared factory called by the server entry point.
 * Uses `create_app_backend` for database + auth, `create_app_server` for
 * middleware assembly, and wires zzz's domain Backend through route deps.
 */
export const create_zzz_app = async (options: CreateZzzAppOptions): Promise<ZzzApp> => {
	const {config, password, runtime, get_connection_ip} = options;
	const {env} = config;

	// Validate keyring and origins from BaseServerEnv fields
	const env_config = validate_server_env(env);
	if (!env_config.ok) {
		console.error(`[server] ERROR: Invalid ${env_config.field}:`);
		for (const err of env_config.errors) console.error(`[server]   ${err}`);
		if (env_config.field === 'SECRET_COOKIE_KEYS') {
			console.error('[server] Generate with: openssl rand -base64 32');
		}
		throw new Error(`Invalid server env: ${env_config.field}`);
	}
	const {keyring, allowed_origins} = env_config;
	log.info('Cookie signing keyring initialized');
	log.info(`Origin verification enabled: ${allowed_origins.length} pattern(s)`);

	const bootstrap_token_path = env_config.bootstrap_token_path ?? null;

	// TODO better config
	const zzz_config = create_config();

	log.info('creating server', {
		zzz_dir: config.zzz_dir,
		scoped_dirs: config.scoped_dirs,
		providers: zzz_config.providers.map((p) => p.name),
		models: zzz_config.models.length,
	});

	// Initialize fuz_app backend (database + auth migrations)
	const app_backend = await create_app_backend({
		database_url: env.DATABASE_URL,
		keyring,
		password,
		stat: runtime.stat,
		read_text_file: runtime.read_text_file,
		delete_file: runtime.remove,
	});

	// Run zzz-specific schema (placeholder — zzz-specific DDL will be added here)
	await init_zzz_schema(app_backend.deps.db);

	log.info(
		`Database initialized (${app_backend.db_type}${app_backend.db_type !== 'pglite-memory' ? ': ' + app_backend.db_name : ''})`,
	);

	// Create zzz domain Backend (files, terminals, providers, actions)
	const backend = new Backend({
		zzz_dir: config.zzz_dir,
		scoped_dirs: config.scoped_dirs.length > 0 ? config.scoped_dirs : undefined,
		config: zzz_config,
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
			api_key: config.secret_anthropic_api_key ?? null,
		}),
	);
	backend.add_provider(
		new BackendProviderChatgpt({
			...provider_options,
			api_key: config.secret_openai_api_key ?? null,
		}),
	);
	backend.add_provider(
		new BackendProviderGemini({
			...provider_options,
			api_key: config.secret_google_api_key ?? null,
		}),
	);

	const started_at = Date.now();

	// Host validation middleware — zzz-specific defense-in-depth for local binding
	const allowed_hostnames = build_allowed_hostnames(config.host);
	const host_validation_middleware = create_host_validation_middleware(allowed_hostnames);

	// Assemble the server with fuz_app's create_app_server
	const app_server: AppServer = await create_app_server({
		backend: app_backend,
		audit_log_sse: true,
		session_options: zzz_session_config,
		allowed_origins,
		proxy: {
			trusted_proxies: ['127.0.0.1', '::1'],
			get_connection_ip,
		},
		bootstrap: {
			token_path: bootstrap_token_path,
		},
		transform_middleware: (specs: Array<MiddlewareSpec>): Array<MiddlewareSpec> => {
			// Insert host validation as the first middleware (before auth)
			return [
				{
					name: 'host_validation',
					path: '*',
					handler: host_validation_middleware,
				},
				...specs,
			];
		},
		create_route_specs: (ctx) =>
			create_zzz_app_route_specs(ctx, {
				audit_sse: ctx.audit_sse ?? undefined,
				zzz: {backend},
				version: config.app_version,
				get_uptime_ms: () => Date.now() - started_at,
			}),
		rpc_endpoints: [create_zzz_rpc_endpoint_spec({backend})],
		env_schema: ZzzServerEnvSchema,
		env_values: env,
		on_effect_error: (error, ctx) => {
			log.error(`Pending effect failed (${ctx.method} ${ctx.path}):`, error);
		},
	});

	return {
		app: app_server.app,
		backend,
		app_backend,
		surface: app_server.surface_spec.surface,
		env,
		allowed_origins,
		close: app_server.close,
	};
};
