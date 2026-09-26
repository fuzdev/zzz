/**
 * Backend-agnostic zzz attack-surface spec for cross-process tests.
 *
 * Rebuilds the surface (route shapes + RPC method/auth metadata) from the
 * shared `action_specs.ts` source of truth plus fuz_app's standard
 * account / admin / audit / bootstrap route bundle — no dependency on a
 * backend implementation. Handler closures are never invoked across the
 * process boundary (live dispatch happens in the spawned Rust binary), so the
 * RPC actions carry no-op handlers; only `spec.method` + `spec.auth` + the
 * route paths are read by the cross-process suites.
 *
 * Mirrors what the production server's route + RPC-endpoint factories
 * contribute, sourcing the RPC actions from `all_action_specs` rather than a
 * `Backend`-bound handler factory.
 *
 * @module
 */

import type { AppServerContext } from '@fuzdev/fuz_app/server/app_server_context.ts';
import { prefix_route_specs, type RouteSpec } from '@fuzdev/fuz_app/http/route_spec.ts';
import type { RpcEndpointSpec, AppSurfaceSpec } from '@fuzdev/fuz_app/http/surface.ts';
import { create_health_route_spec } from '@fuzdev/fuz_app/http/common_routes.ts';
import {
	account_status_route_shape,
	create_account_route_shapes
} from '@fuzdev/fuz_app/auth/account_route_schema.ts';
import { create_signup_route_shape } from '@fuzdev/fuz_app/auth/signup_route_schema.ts';
import { create_standard_rpc_actions } from '@fuzdev/fuz_app/auth/standard_rpc_actions.ts';
import { create_test_app_surface_spec, stub_mw } from '@fuzdev/fuz_app/testing/stubs.ts';
import { fuz_session_config } from '@fuzdev/fuz_app/auth/session_cookie.ts';
import type { RpcAction, ActionHandler } from '@fuzdev/fuz_app/actions/action_rpc.ts';
import type { RequestResponseActionSpec } from '@fuzdev/fuz_app/actions/action_spec.ts';
import { is_protocol_action_method } from '@fuzdev/fuz_app/actions/action_codegen.ts';
import type { MiddlewareSpec } from '@fuzdev/fuz_app/http/middleware_spec.ts';

import { all_action_specs } from '$lib/action_specs.ts';

/** Surface generation never invokes handlers — see module doc. */
const noop_handler = (async () => undefined) as unknown as ActionHandler;

/** Surface generation never invokes route handlers — only `method`/`path`/`auth`/schemas are read. */
const noop_route_handler = (() => new Response()) as unknown as RouteSpec['handler'];

/** Attach a no-op handler to a hono-free route shape so it satisfies `RouteSpec`. */
const shape_to_route_spec = (shape: Omit<RouteSpec, 'handler'>): RouteSpec => ({
	...shape,
	handler: noop_route_handler
});

/**
 * zzz domain RPC actions for surface generation — specs from
 * `all_action_specs`, no-op handlers. Filters for request_response,
 * non-protocol specs (the surface reads only `method` + `auth` metadata).
 */
const zzz_domain_rpc_actions = (): Array<RpcAction> =>
	all_action_specs
		.filter((spec): spec is RequestResponseActionSpec => spec.kind === 'request_response')
		.filter((spec) => !is_protocol_action_method(spec.method))
		.map((spec) => ({ spec, handler: noop_handler }));

/**
 * Build the `/api/rpc` endpoint spec(s) — zzz domain actions plus the standard
 * fuz_app admin / role-grant-offer / account action set. Factory form so the
 * suites' setup-time resolution reads `path` + `spec.method` against a stub ctx.
 */
export const zzz_rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> => [
	{
		path: '/api/rpc',
		actions: [...zzz_domain_rpc_actions(), ...create_standard_rpc_actions(ctx.deps)]
	}
];

/**
 * The `create_account_route_shapes` paths `fuz_auth::account_router` mounts
 * (besides `/status`, which comes from `account_status_route_shape`). An
 * allowlist: a shape fuz_app renames or drops fails loudly here, and one it
 * adds stays off the surface instead of passing vacuously as a 404.
 */
const ACCOUNT_ROUTER_PATHS = ['/login', '/logout', '/password'] as const;

/**
 * Build the zzz route specs (health, account, signup) from the hono-free route
 * shapes plus no-op handlers — never importing the live route factories, which
 * statically pull `hono/cookie` (session middleware) and `hono/streaming`
 * (SSE). The surface reads only `method` / `path` / `auth` / schemas, so the
 * no-op handlers are never invoked.
 *
 * Declares only routes `zzz_server` serves — fuz_auth's `account_router`
 * mounts `/status`, `/login`, `/logout`, `/password` (no `/verify`), and there
 * is no `/api/server/status`.
 */
const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => {
	const account_shapes = create_account_route_shapes({
		login_account_rate_limited: ctx.login_account_rate_limiter !== null
	});
	const account_router_shapes = ACCOUNT_ROUTER_PATHS.map((path) => {
		const shape = account_shapes.find((candidate) => candidate.path === path);
		if (!shape) throw new Error(`fuz_app account route shapes have no '${path}'`);
		return shape;
	});
	return [
		create_health_route_spec(),
		...prefix_route_specs(
			'/api/account',
			[
				account_status_route_shape,
				...account_router_shapes,
				create_signup_route_shape({
					signup_account_rate_limited: ctx.signup_account_rate_limiter !== null
				})
			].map(shape_to_route_spec)
		)
	];
};

/**
 * Create the zzz attack-surface spec for the cross-process suites.
 *
 * Mirrors production assembly: route specs + host_validation middleware +
 * RPC endpoint with zzz domain actions plus the standard admin bundle.
 *
 * @param cookie_name - the backend's session cookie name (zzz's is per-port)
 */
export const create_zzz_app_surface_spec = (cookie_name: string): AppSurfaceSpec =>
	create_test_app_surface_spec({
		session_options: { ...fuz_session_config, cookie_name },
		create_route_specs,
		rpc_endpoints: zzz_rpc_endpoints,
		// zzz wires bootstrap in production; the surface must include
		// `POST /api/account/bootstrap` to match. `surface_only` mounts the
		// route shape (permanent 403) for shape-symmetry tests.
		bootstrap: { mode: 'surface_only' },
		transform_middleware: (specs: Array<MiddlewareSpec>): Array<MiddlewareSpec> => [
			{ name: 'host_validation', path: '*', handler: stub_mw },
			...specs
		]
	});
