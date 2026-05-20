/**
 * Cross-process integration suite for zzz auth surfaces.
 *
 * Wraps the fuz_app standard suites that are cross-process-safe against
 * a spawned backend handle injected by {@link ../cross_backend/global_setup.ts}.
 * The backend is spawned + bootstrapped once per vitest project via
 * `bootstrap_backend`; each suite below opens a fresh per-test fixture
 * via `default_cross_process_setup` (sign up + log in a fresh account
 * per test, mint an API token for both session + bearer credentials).
 *
 * **Suites included** — the cross-process-safe subset of the standard
 * bundle. `describe_standard_tests` itself is not called because it
 * also runs `describe_rate_limiting_tests`, which builds a fresh
 * `TestApp` per test (in-process only, no spawned-backend path):
 *
 * - {@link describe_standard_integration_tests}
 * - {@link describe_standard_admin_integration_tests} (gated on `roles`
 *   from `create_role_schema()`)
 * - {@link describe_round_trip_validation}
 * - {@link describe_rpc_round_trip_tests}
 * - {@link describe_data_exposure_tests}
 *
 * **Suites omitted** (and why):
 *
 * - `describe_rate_limiting_tests` — bypasses `setup_test` to inject
 *   per-test rate-limiter overrides through a fresh `TestApp`; the
 *   spawned-binary path can't accept those overrides.
 * - `describe_audit_completeness_tests` — Tier 2 by the
 *   cross-backend-integration quest design; the suite reaches into
 *   FK-structural introspection that only the in-process backend
 *   exposes.
 * - `describe_bootstrap_success_tests` — bootstrap is one-shot; the
 *   `globalSetup` already consumed it.
 *
 * **Known structural blocker (Phase 3d):** the five suites listed above
 * currently hard-fail at setup time when `surface_source.kind !==
 * 'inline'` (see e.g. `integration.ts:137`, `admin_integration.ts:140`).
 * The fuz_app docstrings flag this explicitly: *"the cross-process
 * snapshot variant lands with the spawned-backend transport"*. Until
 * fuz_app drops those guards (or grows a snapshot-driven route iterator
 * that doesn't need closures), running this file will throw at the
 * first `describe(...)` call. The wiring below is the eventual shape;
 * the snapshot path + module augmentation + `inject()` plumbing are in
 * place so cutover is a single `gro test` once fuz_app catches up.
 * TODO: remove this notice once fuz_app accepts `kind: 'snapshot'`
 * surfaces.
 *
 * @module
 */

import {inject} from 'vitest';
import {
	default_cross_process_setup,
	type BootstrappedBackendHandle,
} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {describe_standard_integration_tests} from '@fuzdev/fuz_app/testing/integration.js';
import {describe_standard_admin_integration_tests} from '@fuzdev/fuz_app/testing/admin_integration.js';
import {describe_round_trip_validation} from '@fuzdev/fuz_app/testing/round_trip.js';
import {describe_rpc_round_trip_tests} from '@fuzdev/fuz_app/testing/rpc_round_trip.js';
import {describe_data_exposure_tests} from '@fuzdev/fuz_app/testing/data_exposure.js';
import {fuz_session_config} from '@fuzdev/fuz_app/auth/session_cookie.js';
import {create_role_schema} from '@fuzdev/fuz_app/auth/role_schema.js';
import {stub} from '@fuzdev/fuz_app/testing/stubs.js';
import type {AppServerContext} from '@fuzdev/fuz_app/server/app_server.js';
import type {RpcEndpointSpec} from '@fuzdev/fuz_app/http/surface.js';

import {build_rpc_endpoint_specs} from '$lib/server/zzz_route_specs.js';

/**
 * Vitest `provide`/`inject` augmentation mirrored from `global_setup.ts`.
 * Both declarations merge into the same `ProvidedContext` shape so the
 * `inject('backend_handle')` call below resolves to
 * `BootstrappedBackendHandle` without a per-site cast.
 */
declare module 'vitest' {
	export interface ProvidedContext {
		backend_handle: BootstrappedBackendHandle;
	}
}

/**
 * Committed `AppSurface` snapshot path. Same fixture
 * `src/test/server/routes/auth_attack_surface.gen.json.ts` produces for
 * the in-process attack-surface tests — single source of truth so
 * cross-process suites see the same wire shape the snapshot tests
 * already gate.
 *
 * Cross-process consumers can only read snapshots (no route closures
 * survive cross-process), so the `{kind: 'snapshot'}` variant of
 * `SurfaceSource` is the only option here. The route iteration
 * suites (`round_trip`, `rpc_round_trip`, `data_exposure`) walk the
 * serialized `AppSurface` shape; the integration suites use it for
 * route lookup + error-coverage scoping.
 */
const SURFACE_SNAPSHOT_PATH = 'src/test/server/routes/auth_attack_surface.json';

const handle = inject('backend_handle');
const setup_test = default_cross_process_setup(handle);
// Each suite calls `resolve_surface_source` itself — pass the discriminated
// shape; the path is resolved lazily inside the suite when the
// `kind: 'snapshot'` guard lifts in fuz_app (see module-docstring TODO).
const surface_source = {kind: 'snapshot', path: SURFACE_SNAPSHOT_PATH} as const;
const {capabilities} = handle.config;
// Pass the factory form so the suites' setup-time resolution
// (`resolve_rpc_endpoints_for_setup` against a stub ctx) reads
// `path` + `spec.method` names. Handler closures are never invoked
// across the process boundary — live dispatch happens in the spawned
// binary, which wires its own `build_rpc_endpoint_specs` against the
// real `Backend`. The `stub` placeholder satisfies the `ZzzRpcDeps`
// shape without touching the real backend; throwing-stub access is
// safe because `create_zzz_action_handlers` only closes over `backend`
// at construction (no property reads).
const zzz_rpc_stub_deps = {backend: stub};
const rpc_endpoints = (ctx: AppServerContext): Array<RpcEndpointSpec> =>
	build_rpc_endpoint_specs(ctx, zzz_rpc_stub_deps);
const session_options = fuz_session_config;
// Built-in roles only — zzz registers no additional role specs today.
// When zzz introduces app-defined roles (e.g. a per-workspace
// collaborator role), thread the registry through `create_role_schema`
// here so the admin suite picks up grant-path coverage.
const roles = create_role_schema([]);

describe_standard_integration_tests({
	setup_test,
	surface_source,
	capabilities,
	session_options,
	rpc_endpoints,
});

describe_standard_admin_integration_tests({
	setup_test,
	surface_source,
	capabilities,
	session_options,
	rpc_endpoints,
	roles,
});

describe_round_trip_validation({
	setup_test,
	surface_source,
	capabilities,
});

describe_rpc_round_trip_tests({
	setup_test,
	surface_source,
	capabilities,
	session_options,
	rpc_endpoints,
});

describe_data_exposure_tests({
	setup_test,
	surface_source,
	capabilities,
});
