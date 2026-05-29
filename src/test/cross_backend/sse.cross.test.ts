/**
 * Cross-process SSE round-trip suite for zzz's admin-gated audit-log stream.
 *
 * Calls `describe_cross_process_sse_tests` against the spawned backend's
 * `GET /api/admin/audit/stream` — the shared `fuz_realtime::audit_stream_router`
 * on the Rust backend. Three cases (the `: connected` comment, an audit `data:`
 * frame on `admin_session_revoke_all`, and close-on-revoke on
 * `account_session_revoke_all`) assert the audit-log SSE wire contract against
 * the fuz_app standard.
 *
 * Gated on `capabilities.sse` (set on the zzz backend config — the backend
 * serves the route). The keeper holds `ROLE_ADMIN` (via `extra_keeper_roles`) so
 * it can subscribe to the admin-gated stream and drive `admin_session_revoke_all`
 * in the data-frame case. Cross-process only — `create_sse_transport` needs a
 * real bound socket, so this lives in a `*.cross.test.ts`, never an in-process
 * setup.
 *
 * @module
 */

import {inject} from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '@fuzdev/fuz_app/testing/cross_backend/setup.js';
import {describe_cross_process_sse_tests} from '@fuzdev/fuz_app/testing/cross_backend/sse_round_trip.js';
import {ROLE_ADMIN} from '@fuzdev/fuz_app/auth/role_schema.js';

import './cross_test_types.js';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
// The keeper needs `ROLE_ADMIN` to subscribe to the admin-gated audit stream
// and to drive `admin_session_revoke_all` in the data-frame case — same
// `extra_keeper_roles` wiring as `auth.cross.test.ts`.
const setup_test = default_cross_process_setup(handle, {extra_keeper_roles: [ROLE_ADMIN]});
const {capabilities, base_url, rpc_path} = handle.config;

describe_cross_process_sse_tests({
	setup_test,
	capabilities,
	base_url,
	rpc_path,
});
