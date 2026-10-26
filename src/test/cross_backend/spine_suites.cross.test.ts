/**
 * Every shipped `@fuzdev/fuz_app` cross suite zzz's capabilities admit, in one
 * `describe_spine_cross_suites` call, against the spawned `zzz_server`. A
 * suite added upstream runs here without a file of its own; one zzz can't run
 * is excluded below with its reason.
 *
 * **Surface source — inline TS.** `create_rust_spine_consumer_surface_spec`
 * builds the declared surface from `all_action_specs` plus the routes the Rust
 * spine mounts for every consumer (`/health`, `fuz_auth::account_router`,
 * signup, bootstrap, one `/api/rpc` endpoint with the standard actions), and
 * `host_gate: true` declares the `host_validation` layer `zzz_server` turns
 * on. No backend dependency: handlers are never invoked across the process
 * boundary.
 *
 * @module
 */

import { fuz_session_config } from '@fuzdev/fuz_app/auth/session_cookie.ts';
import { create_role_schema, ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
import { inject_backend_handle } from '@fuzdev/fuz_app/testing/cross_backend/provided_context.ts';
import {
	create_rust_spine_consumer_rpc_endpoints,
	create_rust_spine_consumer_surface_spec
} from '@fuzdev/fuz_app/testing/cross_backend/rust_spine_consumer_surface.ts';
import {
	describe_spine_cross_suites,
	type SuiteOverrides
} from '@fuzdev/fuz_app/testing/cross_backend/spine_suites.ts';

import { all_action_specs } from '#lib/action_specs.ts';
import { RPC_MESSAGE_MAX_BYTES } from '#lib/rpc_message_limit.ts';

const handle = inject_backend_handle();

// zzz's per-port cookie name (`zzz_session_<port>`) over fuz_app's session shape
const session_options = { ...fuz_session_config, cookie_name: handle.config.cookie_name };

const surface_options = {
	session_options,
	domain_action_specs: all_action_specs,
	host_gate: true
};

// Built-in roles only — zzz registers no app-defined roles.
const roles = create_role_schema([]);

/** The Rust spine's tracked divergences, as on fuz_app's `testing_spine_stub`. */
const overrides: SuiteOverrides = {
	// the `cross_backend_rust` backend serves its static frontend with a `200.html`
	// fallback (`ZZZ_STATIC_DIR`, pinned by `static.cross.test.ts`)
	origin_scope: { unrouted_status: 200 },
	// on the derived multi-actor setup, so its seeding stays the one call's
	transport_composition: (derived) => ({
		multi_actor: derived.multi_actor && {
			...derived.multi_actor,
			xfail: {
				tracking_id: 'rust-ws-upgrade-acting-fail-open',
				reason:
					'the Rust upgrade resolves an account, not an actor, so it admits a multi-actor ' +
					'upgrade that names no actor; per-frame dispatch still resolves each frame'
			}
		}
	})
};

describe_spine_cross_suites(handle, {
	surface_source: create_rust_spine_consumer_surface_spec(surface_options),
	session_options,
	rpc_endpoints: create_rust_spine_consumer_rpc_endpoints(surface_options),
	roles,
	// the builtins only: keeper for the role-shaped cell grants (keeper reach is
	// not admin reach), admin for the conferral
	suite_roles: { cell_grant: ROLE_KEEPER, conferral: ROLE_ADMIN },
	// zzz caps `/api/rpc` and each `/api/ws` message at 16 MiB, not the spine's 1 MiB
	rpc_max_body_bytes: RPC_MESSAGE_MAX_BYTES,
	ws_max_message_bytes: RPC_MESSAGE_MAX_BYTES,
	exclude: {
		actor_lookup: 'zzz mounts no actor_lookup resolver'
	},
	overrides
});
