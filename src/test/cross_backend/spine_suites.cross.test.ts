/**
 * Every shipped `@fuzdev/fuz_app` cross suite zzz's capabilities admit, in one
 * `describe_spine_cross_suites` call, against the spawned `zzz_server`. A
 * suite added upstream runs here without a file of its own; one zzz can't run
 * is excluded below with its reason.
 *
 * **Surface source — inline TS.** `create_rust_spine_consumer_surface_spec`
 * builds the declared surface from `all_action_specs` plus the routes the Rust
 * spine mounts for every consumer (`/health`, `fuz_auth::account_router`,
 * signup, bootstrap, one `/api/rpc` endpoint with the standard actions, and
 * the `host` layer the spine mounts by default). No backend dependency:
 * handlers are never invoked across the process boundary.
 *
 * @module
 */

import { create_role_registry, ROLE_ADMIN, ROLE_KEEPER } from '@fuzdev/fuz_app/auth/role_schema.ts';
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

// zzz's per-port cookie name (`zzz_session_<port>`)
const session_cookie_name = handle.config.cookie_name;

const surface_options = {
	session_cookie_name,
	domain_action_specs: all_action_specs
};

// Built-in roles only — zzz registers no app-defined roles.
const roles = create_role_registry([]);

/** zzz's differences from the spine defaults. */
const overrides: SuiteOverrides = {
	// the `cross_backend_rust` backend serves its static frontend with a `200.html`
	// fallback (`ZZZ_STATIC_DIR`, pinned by `static.cross.test.ts`)
	origin_scope: { unrouted_status: 200 }
};

// the gated skips this backend owes, each by what it lacks — a skip nobody
// listed here fails the run (`check_declared_skips`)
const NO_CELLS = 'zzz_server mounts no cell verbs (cell_crud, cell_relations, cell_gated_create)';
const NO_FACT_SERVING = 'zzz_server mounts no fact serving (fact_serving, fact_serving_admin_hash)';
const NO_READY = 'zzz_server mounts no /ready (ready)';
const SPA_FALLBACK =
	"the backend serves a built frontend, so an unrouted path outside /api gets its SPA shell, not the spine's 404 (spine_fallback)";
const NO_ROOMS = 'zzz_server mounts no room verbs (rooms)';
const NO_ROLE_GATED_WS = 'the /api/ws upgrade has no role gate (ws_role_gated)';
const CONFERRAL_IS_ADMIN =
	"zzz registers no app roles, so the conferral role is admin: global-only (no scoped case) and the audit stream's own gate (no other role to revoke)";

/** `paths`, each declared skipped for `reason`. */
const declare_skips = (reason: string, paths: Array<string>): Record<string, string> =>
	Object.fromEntries(paths.map((path) => [path, reason]));

describe_spine_cross_suites(handle, {
	surface_source: create_rust_spine_consumer_surface_spec(surface_options),
	session_cookie_name,
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
	overrides,
	expected_skips: {
		...declare_skips(NO_CELLS, [
			'cell CRUD parity > owner lifecycle: create → get → update → delete → list',
			'cell CRUD parity > refs are deduped and lexicographically sorted (deterministic, cross-impl-identical)',
			'cell CRUD parity > anon sees public cells only; private is 404',
			'cell CRUD parity > non-owner edit/read/delete of a private cell → 404 (IDOR mask)',
			'cell CRUD parity > admin (keeper) reaches another actor’s private cell',
			'cell CRUD parity > duplicate active path → 409 conflict',
			'cell CRUD parity > path write by non-admin → 403 (create and update)',
			'cell CRUD parity > cell_list pages: limit + offset honored; hidden rows never crowd visible ones out of a page',
			'cell CRUD parity > cell_get without id or path → invalid_params',
			'cell CRUD parity > null-auth cell_list with created_by → invalid_params',
			'cell CRUD parity > authz before input-shape: a non-editor update with kind-in-data → 404, not the kind error',
			'cell CRUD parity > authz before input-shape: a non-admin create with path + kind-in-data → 403, not the kind error',
			'cell CRUD parity > empty kind: rejected on create (cell_kind_empty); accepted as a filter that matches nothing',
			'cell CRUD parity > kind length cap: stored whole at the cap; one unit past it is invalid_params on create and list',
			'cell CRUD parity > mistyped data > cell_create and cell_update refuse it as invalid_params before any cell check',
			'cell CRUD parity > mistyped data > cell_clone refuses it in with_data_patch as invalid_params before any cell check',
			'cell_gated_create authorizer parity (directory model) > a non-admin is denied a `space` root (admin-only), admin succeeds',
			'cell_gated_create authorizer parity (directory model) > a contribution under a public space: unauthorized → 403, participant → allowed',
			'cell_gated_create authorizer parity (directory model) > moderation is set per `moderation_required` (post → pending+private, react → approved)',
			'cell_gated_create authorizer parity (directory model) > a contribution under a hidden (private) space is 404-masked (not 403)',
			'cell_gated_create authorizer parity (directory model) > a deep contribution (comment under a post) resolves policy from the governing root, not the parent',
			'cell_gated_create authorizer parity (directory model) > a contribution under a soft-deleted root is 404 cell_not_found (the missing-parent shape)',
			'cell_gated_create authorizer parity (directory model) > cell root policy parity > a root takes a policy at create and through cell_policy_set, audited old and new',
			'cell_gated_create authorizer parity (directory model) > cell root policy parity > a policy is root-only and must pass the authorizer',
			"cell_gated_create authorizer parity (directory model) > cell root policy parity > an editor-grant holder can't change a root's policy, through the verb or through data",
			'cell_grant role-shaped parity > role grant admits a holder of the role and excludes a non-holder',
			"cell_grant role-shaped parity > cell_list shared_with:'me' admits through the role branch of the grant predicate",
			'cell_grant role-shaped parity > role-shaped grant for an unregistered role is rejected at create',
			'cell_grant role-shaped parity > editor-level role grant admits content edit',
			"cell_grant_steward revoke parity > the scope's steward revokes, audited steward: true",
			"cell_grant_steward revoke parity > another scope's steward gets the 404 mask",
			'cell_grant_steward revoke parity > a scopeless role grant never reaches the hook',
			'cell_moderate verb parity (root-authority-gated) > a root manager (admin) approves a pending post → approved + public',
			'cell_moderate verb parity (root-authority-gated) > the author (non-manager) cannot moderate their own pending post → 403',
			'cell_moderate verb parity (root-authority-gated) > a non-viewer is 404-masked from moderating a pending post',
			'cell_moderate verb parity (root-authority-gated) > a root manager rejects a pending post → rejected, stays private',
			'cell_moderate verb parity (root-authority-gated) > moderating a cell with no governing root → 400 cell_not_a_contribution, after the view check',
			'cell_moderate verb parity (root-authority-gated) > a root owner shown a private approved contribution cannot publish it → 400 cell_not_pending',
			'cell_moderate verb parity (root-authority-gated) > approval needs a pending post, rejection a pending or approved one → else 400 cell_not_pending',
			'moderation gates reads (parity) > a pending post its author flips public stays hidden past the author and admins',
			'moderation gates reads (parity) > pending → rejected → public stays hidden past the author',
			'moderation gates reads (parity) > approved → rejected stays hidden, and a grant made while approved stops admitting',
			'moderation gates reads (parity) > approval leaves visibility to rejection: an approved-then-rejected post is still public, and hidden',
			'moderation gates reads (parity) > an editor grant made while approved admits no write once rejected; the author keeps the owner arm',
			'moderation gates reads (parity) > a pending post in a public collection is omitted from anon cell_item_list',
			'moderation gates reads (parity) > every relation list hides a pending end, and a rejected one from its grant holder',
			"moderation gates reads (parity) > a pending post's fact is 404 to anon, even flipped public; live once approved",
			'the steward arm: a root owner moderates (parity) > a non-admin root owner reads the pending queue and the post, and moderates it',
			'the steward arm: a root owner moderates (parity) > the steward arm stops at the moderator surfaces: clone and create-under are 404',
			'the steward arm: a root owner moderates (parity) > the steward arm keys on the governing root, not the parent: a rejected comment under an approved post',
			"the steward arm: a root owner moderates (parity) > the root owner fetches a pending post's fact; anon 404",
			'cell_grant_create refuses an unapproved contribution (parity) > a grant on a pending post → 403 cell_grant_unapproved; non-manager 404; lands after approval',
			'cell_clone runs the creation authorizer (parity) > a non-admin clone of a viewable `space` root → 403, admin clone succeeds',
			'cell ref admission parity (possession-gated refs) > create admits a new ref only for a holder; refusals are identical for stored and unstored hashes',
			'cell ref admission parity (possession-gated refs) > update keeps existing refs and refuses new unheld ones',
			'cell ref admission parity (possession-gated refs) > clone carries source refs per row without holding them',
			'cell ref admission parity (possession-gated refs) > a global admin is not gated on refs',
			'cell ref admission parity (possession-gated refs) > a revoked grantee cannot re-reference a fact it read',
			'cell ref admission parity (possession-gated refs) > a ref is a whole exact hash string — prose, markup, malformed, and uppercase are not refs',
			'cell ref admission parity (possession-gated refs) > ref admission answers after the 404 masks',
			'cell ref admission parity (possession-gated refs) > clone ref admission answers after the 404 mask',
			'cell relations parity > grant lifecycle: editor grant enables edit; grant_list is manage-tier; revoke drops it',
			'cell relations parity > a grant naming the owner is refused cell_grant_principal_is_owner, whatever the id case',
			"cell relations parity > cell_list shared_with: 'me' lists grant-admitted cells, excludes owned, enriches cell_grants",
			'cell relations parity > null-auth cell_list shared_with → cell_list_shared_with_requires_auth',
			"cell relations parity > cell_list shared_with other than 'me' → invalid_params",
			'cell relations parity > editor-grant holder cannot flip visibility → cell_visibility_manage_only',
			'cell relations parity > field set → forward + reverse list → idempotent delete',
			'cell relations parity > relation lists default to a capped page and honor limit, forward and reverse',
			'cell relations parity > a relation page is visible edges: hidden ends never crowd out a visible one',
			'cell relations parity > relation-list limit: out-of-range and mistyped values refused alike, forward and reverse',
			'cell relations parity > reverse relation lists read oldest edge first, so a page of one is the oldest',
			'cell relations parity > item insert → ordered forward + reverse list → move → idempotent delete',
			'cell relations parity > a taken item position → invalid_params cell_item_position_taken, on insert and on move',
			'cell relations parity > clone: shallow shares edges; deep clones children',
			'cell relations parity > audit_list is manage-tier: owner reads the timeline; viewer-grant gets 404',
			'cell relations parity > relation reads filter non-viewable targets (D8): anon sees only public children',
			'cell relations parity > relation reads filter non-viewable targets (D8): viewer-grant sees only independently-viewable children',
			'cell relations parity > clone D8: shallow drops edges to non-viewable children (no count leak)',
			'cell relations parity > clone D8: deep silently skips non-viewable children (no count leak)',
			'cell relations parity > cell mutation audit metadata omits a null kind and path'
		]),
		...declare_skips(NO_FACT_SERVING, [
			'fact serving parity (cell-scoped per-reference reads) > cell-scoped admit: anon reads a fact through a public referencing cell',
			'fact serving parity (cell-scoped per-reference reads) > cross-owner dedup does not leak: A’s private reference stays 404 while B publishes the same bytes',
			'fact serving parity (cell-scoped per-reference reads) > unviewable private cell: a referenced and an unreferenced hash answer alike',
			'fact serving parity (cell-scoped per-reference reads) > 404-mask: missing cell, missing edge, and edge-without-bytes all 404 alike',
			"fact serving parity (cell-scoped per-reference reads) > an external_url naming another fact's file is a masked 404 on the cell route",
			'fact serving parity (cell-scoped per-reference reads) > an external fact whose disk file is missing is a masked 404',
			"fact serving parity (cell-scoped per-reference reads) > an external_url naming another fact's file is a masked 404 on the bare-hash route",
			'fact serving parity (cell-scoped per-reference reads) > bare-hash route is admin-only',
			'fact serving parity (cell-scoped per-reference reads) > narrowed api token is treated as anonymous on the cell-scoped route',
			'fact serving parity (cell-scoped per-reference reads) > multi-actor caller is treated as anonymous (public-only) on the cell-scoped route',
			'query-shape parity (duplicate keys, unknown keys, phase order) > bare-hash facts: unknown query key → 400 invalid_query_params, even anonymous',
			'query-shape parity (duplicate keys, unknown keys, phase order) > bare-hash facts: duplicated acting takes the first occurrence; malformed acting → 400',
			'request target conformance on the wire > every request row requiring fact_serving_admin_hash answers as the table says',
			'request target conformance on the wire > every request row requiring fact_serving answers as the table says',
			'token scope non-RPC surface parity > a narrowed token is refused the bare-hash fact read (surface:fact_bare)',
			'token scope non-RPC surface parity > a full token is not refused by the scope gate on the same route',
			'token scope non-RPC surface parity > scope outranks role — a narrowed token lacking the role hears about its scope'
		]),
		...declare_skips(NO_READY, [
			'origin check scope parity > a foreign Origin on /ready → 403 forbidden_origin (the check covers every path)',
			'origin check scope parity > an absent Origin on /ready → passes',
			'origin check scope parity > the allowed Origin on /ready → passes',
			'readiness probe parity > anonymous GET /ready → 200 {ready: true} on a clean spine bootstrap'
		]),
		...declare_skips(SPA_FALLBACK, [
			'request target conformance on the wire > every request row requiring spine_fallback answers as the table says',
			'request target conformance on the wire > every request row requiring account_status + spine_fallback answers as the table says'
		]),
		...declare_skips(CONFERRAL_IS_ADMIN, [
			'role_grant_offer WS notifications (cross-process) > a scoped revoke delivers its scope_kind and scope_id to the revokee WS',
			'role-gated participation conferral (success paths) > admin assigns a scoped admin grant that round-trips scope_kind',
			'cross-process sse > a revoke of a global grant of another role leaves the stream open'
		]),
		...declare_skips(NO_ROOMS, [
			'rooms over the socket (cross-process) > members join, relay, set state, and leave, in seq order',
			'rooms over the socket (cross-process) > a watch sees the members without a seat',
			'rooms over the socket (cross-process) > refusals answer their codes and reasons',
			'rooms over the socket (cross-process) > a room past its cap is full, and the admin rule reads the grant',
			'rooms over the socket (cross-process) > a connection watches at most its maximum of rooms',
			'rooms over the socket (cross-process) > over HTTP the room verbs answer method_not_found',
			'rooms over the socket (cross-process) > one seat per actor: the newest admitted join moves the other',
			"rooms over the socket (cross-process) > a closed socket's seats leave as disconnected",
			'rooms over the socket (cross-process) > an eviction ends seats and watches alike',
			'rooms over the socket (cross-process) > the room limiter charges escaped bytes per connection; a watch and a leave still answer past it'
		]),
		...declare_skips(NO_ROLE_GATED_WS, [
			'role-gated websocket (cross-process) > revoking a global grant of a gating role closes the gated socket with WS_CLOSE_PERMISSION_REVOKED',
			'role-gated websocket (cross-process) > a scoped revoke of a gating role closes nothing'
		])
	}
});
