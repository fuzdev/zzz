/**
 * Cross-process integration suite for zzz auth surfaces.
 *
 * Calls `describe_standard_cross_process_tests` — the cross-process subset
 * of the standard fuz_app bundle, omitting `rate_limiting` (in-process
 * fresh-`TestApp` plumbing), `audit_completeness` (FK-structural
 * introspection), and `bootstrap_success` (already consumed by
 * `globalSetup`). See the bundle's module doc for the omission rationale.
 *
 * **Surface source — inline TS.** Cross-process tests construct the
 * `AppSurfaceSpec` in TS via `create_zzz_app_surface_spec`, which rebuilds the
 * surface from `action_specs.ts` + fuz_app's standard route bundle (no backend
 * dependency — see `zzz_surface_spec.ts`). The cross-process-ness lives in the
 * transport (`FetchTransport` against the spawned binary) and the per-test
 * fixture (`default_cross_process_setup`), not in the schema source.
 *
 * @module
 */

import { inject } from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import {
	describe_standard_cross_process_tests
} from '@fuzdev/fuz_app/testing/cross_backend/standard.ts';
import { fuz_session_config } from '@fuzdev/fuz_app/auth/session_cookie.ts';
import { create_role_schema, ROLE_ADMIN } from '@fuzdev/fuz_app/auth/role_schema.ts';

import './cross_test_types.ts';
import { create_zzz_app_surface_spec, zzz_rpc_endpoints } from './zzz_surface_spec.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
// Grant `ROLE_ADMIN` to every per-test signup account via the production
// offer/accept consent flow so the admin-observer tests in
// `describe_standard_integration_tests` (signup invite edge cases) and
// `describe_standard_admin_integration_tests` (invite/role-grant flows)
// can drive admin-gated RPC methods through `fixture.create_session_headers()`.
// Cost: ~2 RPCs × ~30-50ms per test. Cross-process analog of the in-process
// `extra_keeper_roles: [ROLE_ADMIN]` wiring on `default_in_process_suite_options`.
const setup_test = default_cross_process_setup(handle, { extra_keeper_roles: [ROLE_ADMIN] });
const surface_source = create_zzz_app_surface_spec();
const { capabilities } = handle.config;
// Factory form: the suites' setup-time resolution
// (`resolve_rpc_endpoints_for_setup` against a stub ctx) reads `path` +
// `spec.method` names. Handler closures are never invoked across the process
// boundary — live dispatch happens in the spawned Rust binary.
const rpc_endpoints = zzz_rpc_endpoints;
const session_options = fuz_session_config;
// Built-in roles only — zzz registers no additional role specs today.
// When zzz introduces app-defined roles (e.g. a per-workspace
// collaborator role), thread the registry through `create_role_schema`
// here so the admin suite picks up grant-path coverage.
const roles = create_role_schema([]);

describe_standard_cross_process_tests({
	setup_test,
	surface_source,
	capabilities,
	session_options,
	rpc_endpoints,
	roles
});
