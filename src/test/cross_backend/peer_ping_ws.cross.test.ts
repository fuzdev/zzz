/**
 * Cross-process **server-initiated `peer/ping`** suite for zzz — a thin
 * invocation of the shared `@fuzdev/fuz_app` suite, run against the spawned
 * `zzz_server` (Axum) backend via the `cross_backend_*` mechanism.
 *
 * The server→client request/response sibling of the spine's WS notification
 * coverage: a client invokes the `peer/ping` action, the server pings back over
 * the same socket, the client's responder echoes, and the server validates +
 * returns — plus the security negatives. It exercises only spine primitives
 * (accounts, WS, the `ActionPeer` capability) with zero zzz domain, so the
 * suite body lives upstream in fuz_app
 * (`testing/cross_backend/peer_ping_ws.ts`); this file proves zzz's own WS
 * wiring drives it.
 *
 * Gated on `capabilities.peer_request` — `true` for the Rust backend
 * (server-initiated requests are Rust-first canonical; `zzz_server` inherits
 * the spine's `ActionPeer` round-trip via `rust_default_capabilities`), so the
 * `cross_backend_rust` project runs the cases. zzz has no TS reference backend,
 * so there is no `.skip` leg.
 *
 * @module
 */

import {inject} from 'vitest';
import {
	default_cross_process_setup,
	reconstruct_bootstrapped_handle,
} from '@fuzdev/fuz_app/testing/cross_backend/setup.ts';
import {describe_peer_ping_ws_tests} from '@fuzdev/fuz_app/testing/cross_backend/peer_ping_ws.ts';
import {ROLE_ADMIN} from '@fuzdev/fuz_app/auth/role_schema.ts';

import './cross_test_types.ts';

const handle = reconstruct_bootstrapped_handle(inject('backend_handle'));
const setup_test = default_cross_process_setup(handle, {extra_keeper_roles: [ROLE_ADMIN]});
const {base_url, ws_path, capabilities} = handle.config;

describe_peer_ping_ws_tests({
	setup_test,
	capabilities,
	base_url,
	ws_path,
});
