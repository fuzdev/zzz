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

import type {AppServerContext} from '@fuzdev/fuz_app/server/app_server.js';
import {prefix_route_specs, type RouteSpec} from '@fuzdev/fuz_app/http/route_spec.js';
import type {RpcEndpointSpec, AppSurfaceSpec} from '@fuzdev/fuz_app/http/surface.js';
import {
	create_health_route_spec,
	create_server_status_route_spec,
} from '@fuzdev/fuz_app/http/common_routes.js';
import {
	create_account_status_route_spec,
	create_account_route_specs,
} from '@fuzdev/fuz_app/auth/account_routes.js';
import {create_audit_log_route_specs} from '@fuzdev/fuz_app/auth/audit_log_routes.js';
import {create_signup_route_specs} from '@fuzdev/fuz_app/auth/signup_routes.js';
import {create_standard_rpc_actions} from '@fuzdev/fuz_app/auth/standard_rpc_actions.js';
import {create_test_app_surface_spec, stub_mw} from '@fuzdev/fuz_app/testing/stubs.js';
import {fuz_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';
import type {RpcAction, ActionHandler} from '@fuzdev/fuz_app/actions/action_rpc.js';
import type {RequestResponseActionSpec} from '@fuzdev/fuz_app/actions/action_spec.js';
import {is_protocol_action_method} from '@fuzdev/fuz_app/actions/action_codegen.js';
import type {MiddlewareSpec} from '@fuzdev/fuz_app/http/middleware_spec.js';

import {all_action_specs} from '$lib/action_specs.js';

/** Surface generation never invokes handlers — see module doc. */
const noop_handler = (async () => undefined) as unknown as ActionHandler;

/**
 * zzz domain RPC actions for surface generation — specs from
 * `all_action_specs`, no-op handlers. Mirrors `create_zzz_rpc_actions`'s
 * filter (request_response, non-protocol) without binding a `Backend`.
 */
const zzz_domain_rpc_actions = (): Array<RpcAction> =>
	all_action_specs
		.filter((spec): spec is RequestResponseActionSpec => spec.kind === 'request_response')
		.filter((spec) => !is_protocol_action_method(spec.method))
		.map((spec) => ({spec, handler: noop_handler}));

/**
 * Build the `/api/rpc` endpoint spec(s) — zzz domain actions plus the standard
 * fuz_app admin / role-grant-offer / account action set. Factory form so the
 * suites' setup-time resolution reads `path` + `spec.method` against a stub ctx.
 */
export const zzz_rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> => [
	{
		path: '/api/rpc',
		actions: [...zzz_domain_rpc_actions(), ...create_standard_rpc_actions(ctx.deps)],
	},
];

/** Build the zzz route specs (health, account, signup, status, audit SSE). */
const create_route_specs = (ctx: AppServerContext): Array<RouteSpec> => [
	create_health_route_spec(),
	...prefix_route_specs('/api/account', [
		...create_account_route_specs(ctx.deps, {
			session_options: ctx.session_options,
			ip_rate_limiter: ctx.ip_rate_limiter,
			login_account_rate_limiter: ctx.login_account_rate_limiter,
		}),
		...create_signup_route_specs(ctx.deps, {
			session_options: ctx.session_options,
			ip_rate_limiter: ctx.ip_rate_limiter,
			signup_account_rate_limiter: ctx.signup_account_rate_limiter,
		}),
	]),
	create_account_status_route_spec({bootstrap_status: ctx.bootstrap_status}),
	create_server_status_route_spec({version: '', get_uptime_ms: () => 0}),
	...prefix_route_specs('/api/admin', create_audit_log_route_specs({stream: undefined})),
];

/**
 * Create the zzz attack-surface spec for the cross-process suites.
 *
 * Mirrors production assembly: route specs + host_validation middleware +
 * RPC endpoint with zzz domain actions plus the standard admin bundle.
 */
export const create_zzz_app_surface_spec = (): AppSurfaceSpec =>
	create_test_app_surface_spec({
		session_options: fuz_session_config,
		create_route_specs,
		rpc_endpoints: zzz_rpc_endpoints,
		// zzz wires bootstrap in production; the surface must include
		// `POST /api/account/bootstrap` to match. `surface_only` mounts the
		// route shape (permanent 403) for shape-symmetry tests.
		bootstrap: {mode: 'surface_only'},
		transform_middleware: (specs: Array<MiddlewareSpec>): Array<MiddlewareSpec> => [
			{name: 'host_validation', path: '*', handler: stub_mw},
			...specs,
		],
	});
