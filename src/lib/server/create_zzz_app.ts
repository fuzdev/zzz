/**
 * Runtime-agnostic zzz app factory.
 *
 * Creates the full application by combining fuz_app's `create_app_backend`
 * and `create_app_server` with zzz's domain Backend, AI providers, and
 * WebSocket endpoint. Called by the server entry point (`server/server.ts`).
 *
 * @module
 */

import type {Context, Hono} from 'hono';
import {Logger} from '@fuzdev/fuz_util/log.js';
import {validate_server_env} from '@fuzdev/fuz_app/server/env.js';
import {
	create_app_backend,
	default_audit_factory,
	type AppBackend,
} from '@fuzdev/fuz_app/server/app_backend.js';
import {
	create_app_server,
	require_audit_sse,
	type AppServer,
} from '@fuzdev/fuz_app/server/app_server.js';
import type {AppSurface} from '@fuzdev/fuz_app/http/surface.js';
import type {PasswordHashDeps} from '@fuzdev/fuz_app/auth/password.js';
import type {StatResult} from '@fuzdev/fuz_app/runtime/deps.js';
import type {MiddlewareSpec} from '@fuzdev/fuz_app/http/middleware_spec.js';

import type {Action} from '@fuzdev/fuz_app/actions/action_types.js';
import type {RpcAction} from '@fuzdev/fuz_app/actions/action_rpc.js';
import type {AppDeps} from '@fuzdev/fuz_app/auth/deps.js';

import {build_allowed_hostnames, create_host_validation_middleware} from './security.js';
import {Backend} from './backend.js';
import {
	ZzzServerEnv as ZzzServerEnvSchema,
	type ZzzServerConfig,
	type ZzzServerEnv,
} from './server_env.js';
import {all_action_specs} from '../action_specs.js';
import {
	_testing_emit_notifications_action_spec,
	handle_testing_emit_notifications,
	testing_action_specs,
} from '../testing_action_specs.js';
import {handle_filer_change} from './backend_actions_api.js';
import {BackendProviderOllama} from './backend_provider_ollama.js';
import {BackendProviderClaude} from './backend_provider_claude.js';
import {BackendProviderChatgpt} from './backend_provider_chatgpt.js';
import {BackendProviderGemini} from './backend_provider_gemini.js';
import create_config from '../config.js';
import {zzz_session_config} from './routes/account.js';
import {create_zzz_app_route_specs, build_rpc_endpoint_specs} from './zzz_route_specs.js';
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
	/**
	 * Optional factory for additional RPC actions to register on the live
	 * dispatcher. Invoked after `app_backend` and the zzz domain `backend`
	 * are constructed, so the factory can close over both. Used by the
	 * Node test-binary entry (`testing_server_node.ts`) to inject the
	 * `_testing_reset` action from fuz_app's
	 * `create_testing_reset_actions` factory with a `reset_state` callback
	 * that clears zzz domain state (workspaces, terminals, optional
	 * scoped-FS scratch).
	 *
	 * Production entries leave this unset.
	 */
	extra_rpc_actions_factory?: (deps: AppDeps, backend: Backend) => ReadonlyArray<RpcAction>;
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
	/**
	 * WebSocket-side test actions to register when `ZZZ_ENABLE_TEST_ACTIONS=1`.
	 * Empty in production. Callers that mount the WS endpoint pass these
	 * through to `register_websocket_actions`.
	 */
	extra_ws_actions: ReadonlyArray<Action>;
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
		if (env_config.field === 'SECRET_FUZ_COOKIE_KEYS') {
			console.error('[server] Generate with: openssl rand -base64 32');
		}
		throw new Error(`Invalid server env: ${env_config.field}`);
	}
	const {keyring, allowed_origins} = env_config;
	log.info('Cookie signing keyring initialized');
	log.info(`Origin verification enabled: ${allowed_origins.length} pattern(s)`);

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
		audit_factory: default_audit_factory,
	});

	// Run zzz-specific schema (placeholder — zzz-specific DDL will be added here)
	await init_zzz_schema(app_backend.deps.db);

	log.info(
		`Database initialized (${app_backend.db_type}${app_backend.db_type !== 'pglite-memory' ? ': ' + app_backend.db_name : ''})`,
	);

	// In integration-test runs (`ZZZ_ENABLE_TEST_ACTIONS=1`), splice the
	// `_testing_*` specs and handler into the live dispatchers. Production
	// leaves the env var unset so the action surface stays clean.
	const action_specs = config.enable_test_actions
		? [...all_action_specs, ...testing_action_specs]
		: all_action_specs;
	const env_test_rpc_actions: ReadonlyArray<RpcAction> = config.enable_test_actions
		? [
				{
					spec: _testing_emit_notifications_action_spec,
					handler: handle_testing_emit_notifications,
				},
			]
		: [];

	if (config.enable_test_actions) {
		log.info('Test actions enabled — `_testing_*` methods registered on live dispatchers');
	}

	// Create zzz domain Backend (files, terminals, providers, actions)
	const backend = new Backend({
		zzz_dir: config.zzz_dir,
		scoped_dirs: config.scoped_dirs.length > 0 ? config.scoped_dirs : undefined,
		config: zzz_config,
		action_specs,
		handle_filer_change,
	});

	// Compose env-gated test actions with caller-supplied actions (test
	// binary's `_testing_reset`). Production entries pass no factory.
	const extra_rpc_actions = options.extra_rpc_actions_factory?.(app_backend.deps, backend) ?? [];
	const test_rpc_actions: ReadonlyArray<RpcAction> = [
		...env_test_rpc_actions,
		...extra_rpc_actions,
	];
	const test_ws_actions: ReadonlyArray<Action> = env_test_rpc_actions;

	// Register AI providers. Streaming progress is routed per-request via
	// `ctx.notify` — providers have no broadcast callback.
	backend.add_provider(new BackendProviderOllama());
	backend.add_provider(
		new BackendProviderClaude({api_key: config.secret_anthropic_api_key ?? null}),
	);
	backend.add_provider(new BackendProviderChatgpt({api_key: config.secret_openai_api_key ?? null}));
	backend.add_provider(new BackendProviderGemini({api_key: config.secret_google_api_key ?? null}));

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
		bootstrap: env_config.bootstrap_token_path
			? {mode: 'live', token_path: env_config.bootstrap_token_path}
			: {mode: 'disabled'},
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
				audit_sse: require_audit_sse(ctx),
				zzz: {backend},
				version: config.app_version,
				get_uptime_ms: () => Date.now() - started_at,
			}),
		rpc_endpoints: (ctx) =>
			build_rpc_endpoint_specs(ctx, {backend, extra_actions: test_rpc_actions}),
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
		extra_ws_actions: test_ws_actions,
		close: app_server.close,
	};
};
