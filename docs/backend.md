# Backend internals

The Rust backend's details, for working on `crates/`: each crate in full,
the auth mechanics, the cross-process test suites, known issues, and the
design decisions behind `zzzd`. Orientation, the module map, build and run,
endpoints, and env vars are in ../crates/CLAUDE.md.

## Crates

- `zzz_server/` — library (`zzz_server`) + production daemon binary (the
  `[[bin]]` target is named `zzzd`).
  `pub async fn run_app(options: RunAppOptions)` in `src/lib.rs` owns the
  full lifecycle over the spine's server toolkit (`fuz_actions::server`:
  `create_app_backend` boots the core — keyring, the READ COMMITTED guard,
  the pre-migration hook, the auth migrations, the keeper, bootstrap
  availability, the revocation listeners — then `serve_until_shutdown`
  binds, runs the auth cleanup beside the server, and drains; zzz's jobs and
  PTYs are torn down after). `RunAppOptions` carries: `spine` (the toolkit's
  `SpineRunOptions` — the password hasher, the `fuz_auth::RateLimiterMode`
  every spine limiter is built through (`Enforced` in production,
  `DisabledForTesting` in the test binary only), the daemon-token state (the
  test binary's keeper credential; production `None`), the pre-migration
  hook (the test binary's `fuz_testing::startup_reset_hook`), in-flight
  audit tracking (so the test binary's `_testing_drain_effects` awaits
  detached audit writes), `default_addr` (bind address when
  `--port`/`ZZZ_PORT` don't supply one; host stays loopback, only the port
  is overridable), and `drain_timeout`), `args` (the parsed command line),
  `force_test_actions` (overrides the `ZZZ_ENABLE_TEST_ACTIONS` env flag),
  and `extra_action_specs_factory` (lets the test binary inject
  `_testing_reset`, `_testing_drain_effects`, and `_testing_action_manifest`
  without putting `fuz_testing` in the production dep graph). The core's
  emitter is also held on `App` (`audit_emitter`), where the test binary's
  specs factory reaches it. `src/main.rs` is the thin production entry —
  parses the command line, constructs `Argon2idHasher`, calls `run_app` with
  `SpineRunOptions::production`.
- `testing_zzz_server/` — separate test-binary package (its `[[bin]]` target
  is named `testing_zzzd`) wiring `fuz_testing::TestingArgon2idHasher` (~1-5
  ms argon2 vs production's ~30-50 ms) AND
  `fuz_testing::create_testing_reset_action_spec` (auth-table wipe +
  fresh-keeper re-seed + consumer-supplied `reset_state(ActionDb)` callback;
  `credential_types: [DaemonToken]` auth gate) and
  `fuz_testing::create_testing_drain_effects_action_spec`
  (`_testing_drain_effects`, the barrier awaiting in-flight fire-and-forget
  audit writes — a real one because this binary passes
  `audit_inflight_tracking: true`), and
  `fuz_testing::create_testing_action_manifest_action_spec`
  (`_testing_action_manifest`, over zzz's own specs alone —
  `build_zzz_owned_specs` and `build_testing_specs` — not the spine's
  bundle). zzz's reset closure ignores the in-tx
  `ActionDb` handle (its domain state is in-memory, not in PG) — it closes
  every zzz project through the production close path
  (`ProjectManager::close_all` — filers stopped, `ScopedFs`
  roots removed, `project_changed` broadcast, restoring the boot-time
  scope), calls `pty_manager.kill_all()` (non-destructive — manager stays
  usable across tests), stops and forgets every job
  (`job_manager.cancel_all()`), and wipes the optional
  `ZZZ_TESTING_SCRATCH_DIR`. Default port 4462 (production is 4460). **Never
  ships in a release** — enforced by `fuz_release`'s `testing_` manifest
  filter and the `cargo xtask check-release` dep-graph audit. It is zzz's test
  binary, spawned by the cross-process integration tests.
- `xtask/` — dev automation (`cargo xtask <cmd>`, pure `std` + `fuz_audit`, no
  extra deps). `dev` loads `.env.development`, runs the `ghostty-vt` step
  below (a no-op when the module is current, a build when it's missing or
  stale; when it fails — no Zig, no network, a failed build — it warns, saying
  whether terminals will use the installed module or show it missing, and
  carries on: `ghostty_vt_dev_step`, `ghostty_vt_dev_warning`), builds
  `zzz_server`, checks port 4461 is free, then runs `zzzd` (port 4461) + the
  Vite frontend (`node_modules/.bin/vite dev` run directly — `npx` doesn't
  forward signals; 5460, proxying `/api`), with the inherited env overlaid by
  `.env.development` — the file's non-blank values win (the opposite of the
  CLI's rule; a blank `KEY=` line is unset, never clearing an exported value),
  printing each inherited key it overrides (never the value), forcing the
  frontend's own ports (`PUBLIC_ZZZ_SERVER_PORT` 5460,
  `PUBLIC_ZZZ_SERVER_PROXIED_PORT` 4461, `PUBLIC_ZZZ_WEBSOCKET_URL`) whatever
  the file says, warning — with the line to set; the file is never rewritten —
  when the file's `PUBLIC_ZZZ_SERVER_PORT` isn't the dev port
  (`dev_server_port_warning`: a Vite started without xtask reads the file, and
  `vite.config.ts` refuses to start on a mismatch), when no
  `FUZ_ALLOWED_ORIGINS` entry admits the dev UI's origin
  `http://localhost:5460`, and when an entry is a loopback origin on a default
  Vite port (`dev_origin_warning`, which matches entries by
  `fuz_http::AllowedOrigins::allows`'s rule — a copy, as xtask doesn't link
  the spine — and says whether the value came from the file or the inherited
  environment), holding both children in guards that `SIGTERM` (then
  `SIGKILL`) and reap the survivor on every exit path; `dev-setup` /
  `prod-setup` create `.env.development` / `.env.production` from the
  `.example` templates (mode `0600`, `create_new`) with a freshly generated
  `SECRET_FUZ_COOKIE_KEYS` — the templates ship the key empty; `check-release`
  (the dep-graph audit, one of the test-binary pattern's sanity checks) delegates
  its work to `fuz_audit::run_check_release_cli()`; `ghostty-vt`
  (`ghostty_vt.rs`) builds libghostty-vt's WebAssembly module for the
  `fuz_terminal` library (`src/lib/fuz_terminal/`, which draws zzz's
  terminals) — it checks `curl`, `tar`, `sha256sum`, and Zig `0.17.x` (an
  official release; the pinned libghostty-vt builds with no other minor) run,
  downloads the pinned release's source and dependency tarballs into
  `target/ghostty-vt/` (`curl` with a 30s connect timeout and a stall limit;
  the version and both sha256s are constants; a cached tarball is reused only
  when its hash matches, and a download that doesn't match is deleted and
  refused, naming the file and both hashes, before anything is unpacked),
  unpacks both into a fresh directory, builds offline (`zig build --system
  <deps> -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
  -Dvt-features=-all,+render-state,+input-encode,+selection,+formatter`, with
  `ZIG_GLOBAL_CACHE_DIR` a new empty directory, as upstream's packaging guide
  requires, and `DESTDIR` removed from its environment), checks the output is
  WebAssembly, and installs it at `static/fuz_terminal/ghostty-vt.wasm`
  (gitignored, as is the temp file beside it; temp file + rename — and every
  run first removes a temp file an interrupted install left there, which `gro
  build` would otherwise ship; one it can't remove is an error), then writes a
  stamp recording the pins, the Zig version, the feature set, and the module's
  sha256 — a run whose stamp matches the installed module is a no-op that says
  so. Every program runs from an argument vector, never a shell. Dispatch and
  usage live in xtask itself: bare `cargo xtask` / `help` / `-h` / `--help`
  print the full subcommand list (exit 0); an unknown subcommand (a non-UTF-8
  one included — args are read with `args_os`), or any argument after a
  subcommand (none takes one), prints an error + usage (exit 1). Every
  subcommand runs from the workspace root (the grandparent of
  `CARGO_MANIFEST_DIR` — the one `cargo run` sets at run time, else the one
  baked in at build time, which goes stale in a copied checkout), so it works
  from any directory in the checkout — the env files,
  `node_modules/.bin/vite`, `target/debug/zzzd`, `target/ghostty-vt/`,
  `static/`, and `.env.development`'s relative paths (resolved by the children
  against their working directory) are always the workspace's. Marked
  `[package.metadata.fuz_audit] dev_only = true` so xtask itself is excluded
  from the production scan.
- `zzz/` — Rust CLI (argh). `daemon start/stop/status`, `status`, `init`,
  `open` (the default command — opener resolution, path resolution, daemon
  discovery, detached auto-start, then the configured opener or the browser),
  and `version` (+ the `--version`/`-v` switch). Modules: `daemon_launch.rs`
  (the `zzzd` command: `--port`, `--static-dir`, cwd `~/.zzz`, and the env
  overlay from `~/.zzz/.env` + defaults, with required-var / static-dir / port
  / `config.json` validation, the note naming `.env` keys the environment
  overrides, and `ZZZ_ENABLE_TEST_ACTIONS` stripped; `CliConfig`, the one
  reader of `config.json`), `opener.rs` (the open command run instead of the
  browser: `opener` in `config.json` — a string, or an array of the program
  and its arguments — then `ZZZ_OPENER`; blank reads as unset; the program
  whitespace-trimmed, `~`-expanded, resolved against `~/.zzz` or the CLI's
  directory by source, and required to be an executable file — a bare name (no
  `/`, `~name` included) is refused from both sources, never searched for on
  `$PATH` or run from the current directory; the URL appended as its own final
  argument, no shell, so a `--flag=<url>` form needs a wrapper script; output
  in `run/opener.log`, emptied at each launch; `ZZZ_ENABLE_TEST_ACTIONS`
  removed), `daemon_lifecycle.rs` (`resolve_server_bin` — `ZZZ_SERVER_BIN`
  (must be an executable file) > beside the resolved CLI executable >
  `~/.zzz/bin` > absolute `$PATH` entries, skipping non-executable candidates,
  never the current directory; `parse_port`, the one `1..=65535` rule for
  `--port` (argh `from_str_fn`), `ZZZ_PORT`, and `zzz_config_port`;
  `daemon.json` v2 I/O with ownership-checked removal and foreign-record
  reporting — an older/newer/corrupt record is never signalled, removed, or
  overwritten, so a start refuses to run; the proxy-free `/health` probe on
  `127.0.0.1`, the serving wait, `create_private_log` + `spawn_detached` (the
  detached spawn the auto-started daemon and the opener share: own process
  group, output appended to a `0600` log under `~/.zzz/run` that each launch
  empties), shutdown-signal handling, `stop_child` SIGTERM → SIGKILL → reap,
  terminate), `procfs.rs` (Linux `/proc` identity: boot id, pid start time,
  listening-socket ownership), `env_file.rs` (the dotenv parser — std-only,
  also compiled into xtask via `#[path]`; its module doc lists where it
  diverges from `dotenv`). `zzz status` / `zzz daemon status` exit 0 when
  running, 1 when alive but not responding, 3 when not running, 4 when unknown
  (a `daemon.json` this zzz can't read). With `--json` they print one object
  whose keys are always all present: `state` (`running`, `not_responding`,
  `not_running`, `stale` — the record named a process that's gone and was
  removed — or `unknown`), `running` (the recorded process is alive),
  `healthy` (it answers `/health`), `daemon` (the `daemon.json` record —
  `version`, `pid`, `boot_id`, `pid_start_ticks`, `port`, `started`,
  `app_version` — for `running` / `not_responding` / `stale`, else `null`),
  and `foreign_record` (`{pid, kind, description}` for `unknown`, `kind` one
  of `older` / `newer` / `unreadable`, `pid` `null` when it names none; else
  `null`). The CLI reads its args with `args_os`, so a non-UTF-8 argument is
  an error, never a panic (the program name is decoded lossily — argh only
  shows it in help). Usage and config errors — argh parse errors included —
  exit 2; `--help` exits 0. See ./development.md § The `zzz` CLI for the
  launch rules. Tests: unit tests per module, `tests/cli_daemon.rs`
  (infra-free: status + stale/reused-pid/older-zzz records (a start refuses to
  overwrite one), launch validation (ports at every source, `config.json`,
  env-override notes, `ZZZ_ENABLE_TEST_ACTIONS` stripped, never a `zzzd` from
  the current directory), early child exit, `init` file modes, the opener (a
  stand-in script recording its arguments: the URL as the single final
  argument for a project path a shell would mangle, array arguments passed
  through, config over env, blank values unset, the browser stub as the
  fallback, no `ZZZ_ENABLE_TEST_ACTIONS`; a missing or non-executable program,
  a bare name from either source, and a malformed `opener` exit 2 with nothing
  launched), full foreground + detached lifecycles and signals during startup
  against a `sh` + `python3` stand-in daemon — a visible SKIPPED line without
  `python3` — with a drop guard that kills stand-ins on failure), and
  `tests/cli_e2e.rs` (full `daemon start` ↔ live `testing_zzzd` lifecycle,
  gated behind `ZZZ_TEST_E2E=1` + Postgres, self-skips otherwise). Build it
  with `cargo build -p zzz`.

## Auth

zzz is single-operator: every session and every full-scope API token
effectively has the daemon OS user's powers — see
./architecture.md § Security posture.

Cookie-based session auth and bearer token auth. These mechanics are
spine behaviors (`fuz_auth` / `fuz_http` / `fuz_realtime`) that `run_app`
composes — `zzz_server` owns none of this code. Summarized here for
orientation; the spine crates are authoritative:

1. **Keyring** — HMAC-SHA256 cookie signing with key rotation support.
   Keys from `SECRET_FUZ_COOKIE_KEYS` env, separated by `__`. First key signs,
   all keys verify.

2. **Cookie format** — `zzz_session_<port>` cookie (per port —
   `session_cookie_name_for_port` — since browsers scope cookies by host, not
   port, so zzz daemons on one host would otherwise share, and clobber, one
   session) containing signed
   `{session_token}:{expires_at}.{base64_signature}`. 30-day expiry,
   `Secure; HttpOnly; SameSite=Strict`.

3. **Session validation** — Cookie → HMAC verify → blake3 hash token →
   `auth_session` table lookup → build `RequestContext` (account, actor,
   role grants). Pure read — sessions are never touched or renewed; the
   30-day lifetime is an absolute cap set at mint, and the row carries no
   activity signal.

4. **Bearer token auth** — `Authorization: Bearer <token>` header. Token
   hashed with blake3, looked up in `api_token` table. Browser context
   silently discarded (Origin/Referer headers present → bearer ignored). Token
   `last_used_at` touched fire-and-forget. Sets `CredentialType::ApiToken`.

5. **Daemon token auth** — `X-Daemon-Token` header. **Not mounted in
   production.** `zzz_server` cannot construct the credential: its producer
   (`fuz_testing::init_daemon_token`) lives in `fuz_testing`, which
   `cargo xtask check-release` forbids in a production binary, and
   `RunAppOptions::daemon_token_state` is `None` for `zzz_server`'s own
   `main.rs`. Only `testing_zzz_server` supplies one, so `_testing_reset` can
   authenticate as keeper; it writes `{zzz_dir}/run/daemon_token` for the
   cross-process harness to read. No production caller exists — a browser
   request carries `Origin`/`Referer`, which `is_browser_context` refuses for
   this credential. The spine keeps the consuming half (constant-time compare,
   keeper resolution, `CredentialType::DaemonToken`) in `fuz_auth`; state is
   protected by `parking_lot::RwLock`.

6. **Auth pipeline** — Both transports try: daemon token → cookie → bearer.
   Daemon token has highest priority (matches fuz_app middleware order), but
   its leg is unreachable in production, where the state is `None`.
   `ResolvedAuth` carries a `ResolvedCredential` (`Session { session_hash }`,
   `ApiToken { api_token_id, scope }`, `DaemonToken`), read through
   `credential_type()` / `scope()` / `session_hash()` / `api_token_id()`.

7. **Per-action auth** — these levels are the enforcement shorthand for the
   `auth` record on each TS spec (fuz_app's `RouteAuth`: `{account, actor,
   roles?, credential_types?, required_scope?}`; see `src/lib/action_specs.ts`
   and the generated `docs/reference.md`):
   - `public` — `{account: 'none', actor: 'none'}`; no auth required (`ping`)
   - `account-grain` — `{account: 'required', actor: 'none'}`; valid session
     or bearer token required. Every zzz action but `ping`: its domain
     belongs to the account, and no handler reads an actor. The Rust
     builders use `AuthSpec::account_grain` (not `authenticated`, which
     also requires an actor); `action_manifest.cross.test.ts` holds the two
     sides together
   - `keeper` — `{account: 'required', actor: 'required', roles: ['keeper'],
     credential_types: ['daemon_token']}`; requires `DaemonToken` credential
     type AND keeper role grant. No zzz action uses this shape today — the
     daemon-token credential is test-binary-only (see Auth §5), so the only
     keeper-gated specs are `fuz_testing`'s `_testing_*` backdoors. API tokens
     and session cookies cannot access keeper actions even if the account has
     the keeper role grant.

8. **Bootstrap** — `POST /api/account/bootstrap` creates the first admin
   account with keeper + admin role grants. Reads the token from
   `FUZ_BOOTSTRAP_TOKEN_PATH`, timing-safe compare, Argon2 password hashing,
   all in a transaction with bootstrap_lock.

9. **Origin verification** — `FUZ_ALLOWED_ORIGINS` patterns checked on requests
   with an `Origin` header. Supports exact match, wildcard port
   (`http://localhost:*`), and wildcard host labels — each `*` is any one
   label, in any position (`https://*.example.com`, `https://example.*`), and
   a host of only `*` labels (`http://*`, `https://*.*`) is every host with
   that many labels.
   `origin_allowlist::allowed_origins_from_env` reads the list in
   `parse_config`:
   - **Malformed entries refuse the boot** (`fuz_http::AllowedOrigins::parse`,
     the grammar `fuz_http` shares with fuz_app's TS spine; every refused
     entry is named): an empty entry (a stray comma), anything but printable ASCII without
     spaces, no `scheme://`, a scheme other than http or https, a path /
     query / fragment / trailing slash, userinfo, an empty host, a character
     no hostname holds (a percent-encoding included), a `*` that isn't a
     whole label, an IPv4 address not written as four decimal numbers, an
     IPv6 address unbracketed or not in the form a browser sends, a port
     outside `1..=65535` or with leading zeros, and a scheme's default port
     written out. The check is of the shape, not a proof that the entry
     matches something: a hostname a browser would rewrite (an invalid
     punycode label) passes and matches nothing.
   - **Wildcard entries need the opt-in** — the spine's boot
     (`fuz_actions::server::create_app_backend`, through
     `fuz_http::admit_origin_wildcards`) refuses one unless
     `FUZ_ALLOW_ORIGIN_WILDCARDS=true` (read strictly in `parse_config`:
     exactly `true` or `false`), with text that says which it is — port, host,
     or both — and what it admits: any port on the host, any host matching the
     pattern, or, when no label is fixed, every host of that shape (four `*`
     labels cover every IPv4 address). With the flag it boots and logs that
     text as a warning on every boot. The `Host` gate below admits the hosts
     the same entries name, on either scheme, so a host wildcard also lets a
     DNS-rebinding page on a matching domain through it; the text says so
     (`origin_allowlist::ZZZ_BROWSER_GATES` turns the gate on and adds zzz's
     note).
   `tests/boot_allowed_origins.rs` runs the real `zzzd` over each case.
   The router is `fuz_http::compose_stack`'s (`router.rs`): route groups,
   each with its own body cap — `rpc` (`/api/rpc` + `/api/ws`,
   `RPC_MESSAGE_MAX_BYTES`), `file_bytes` (`FILE_BYTES_MAX_BODY_BYTES`),
   `account` (account, bootstrap, signup), `health_and_audit` (`/health` +
   the audit stream), and the fallback (the static frontend, or axum's empty
   404), the last three at `fuz_http::DEFAULT_BODY_LIMIT_BYTES` — and every
   group, the fallback included, behind the same gates, outermost first: the
   group's body cap (a declared `Content-Length` over it is a 413 ahead of
   every other refusal), `fuz_http::host_layer` (a `Host` that isn't loopback
   or named by an allowed origin → 403 `forbidden_host` — DNS rebinding),
   `fuz_http::origin_layer` (a disallowed `Origin` → 403 `forbidden_origin` on
   every path; no group is carved out — the spine handlers and the byte
   routes check it again through the `fuz_auth::AuthGate`),
   `fuz_http::simple_request_layer` (a `POST` with no `Content-Type` or a form
   / text one → 415 `unsupported_content_type` — a request a browser sends
   cross-origin with no preflight, carrying the cookie from any other
   `localhost` port), then `fuz_http::client_ip_middleware`. Request tracing
   is off. The `router.rs` tests pin each gate on every group through the
   composed router. The spine's JSON handlers (RPC
   POST, login, logout, password, bootstrap, signup) also require
   `application/json` themselves, as fuz_app's routes do. See ./architecture.md § Security posture.

10. **Connection revocation** — `close_connections(&ConnectionCloseTarget)` (`Session` /
    `Token` / `Account` / `Role`) is the spine's `ConnectionCloser` method;
    `run_app` binds `fuz_realtime::RealtimeCloser`, which fans each
    close to the WS `ConnectionRegistry` and the audit-stream `SseRegistry`
    (`App` itself carries only a `broadcast` shim). They close matching
    WebSocket connections by dropping the channel sender — the ws loop breaks
    on `recv()` returning `None` and sends a 4001 (`WS_CLOSE_SESSION_REVOKED`)
    Close frame so clients can distinguish revocation from normal close — and
    end matching audit streams the same way.
    Invoked by the spine's revocation-emitting handlers and audit-event
    listeners: `session_revoke` (per-session), `token_revoke` /
    `account_token_revoke` (per-token), and `logout` / `session_revoke_all`
    / `token_revoke_all` / `password_change` (account-wide). The auth
    cleanup invokes the per-session close too, for each expired session it
    deletes (see "Auth cleanup" under Architecture). The RPC handlers close
    only after their transaction commits (`fuz_auth::queue_connection_close`), so
    a client's recheck on a 4001 never finds the revoked session still in the
    table; the REST ones close inline on their autocommit client. See "Audit
    emission" under Architecture for the listener chain.

11. **Account status** — `GET /api/account/status` returns account info +
    role grants (200) when authenticated, or 401 with optional
    `bootstrap_available` flag when not. Consumed by fuz_app's `AuthState`
    for the frontend auth gate (bootstrap → login → verified flow).

12. **Account management** — `POST /api/account/login` (username/password →
    session cookie with enumeration prevention via dummy hash),
    `POST /api/account/logout` (invalidate session + close WS connections),
    `POST /api/account/password` (change password, revoke all sessions + API
    tokens, close all WS connections). Session listing and revocation are
    JSON-RPC: `account_verify`, `account_session_list`,
    `account_session_revoke`, `account_session_revoke_all`,
    `account_token_create`, `account_token_list`, `account_token_revoke`
    (all scoped to the authenticated account), plus the admin role-gated
    `admin_session_revoke_all` / `admin_token_revoke_all` which target a
    caller-supplied `account_id`.

## Integration test suites

The suites in `src/test/cross_backend/`, run by the `cross_backend_*` vitest
projects (../crates/CLAUDE.md § Integration Tests has the harness and
commands):

- **`spine_suites.cross.test.ts`** — every shipped fuz_app cross suite the
  backend's capabilities admit, in one `describe_spine_cross_suites` call:
  the standard bundle (HTTP + RPC round-trip, admin, auth enforcement,
  bearer tokens on HTTP + WS), the WS, SSE (`GET /api/admin/audit/stream`)
  and server-initiated `peer/ping` suites, the front-door, origin, body-size,
  cookie, token and role-grant suites. The declared surface is
  `create_rust_spine_consumer_surface_spec` over `all_action_specs` with
  `host_gate: true` — no backend dependency. Excluded with its reason shown in
  the run: `actor_lookup` (no resolver mounted). The capabilities, including
  `testing_backdoors` (`_testing_reset`, `_testing_drain_effects`, and
  `_testing_action_manifest`, the ones `testing_zzzd` mounts), are stated in
  `zzz_backend_config.ts`; the testing-backdoor suite checks that list
  against the binary, and the suites needing another backdoor
  (`credential_deadline`, `origin_conformance`, `ws_outbound_overflow`) skip
  themselves, naming it.
- **`action_manifest.cross.test.ts`** — zzz's own request specs against
  their Rust twins: the methods registered, and each one's input shape, auth
  axes, role and credential gates, `side_effects`, and rate-limit class
  (`_testing_action_manifest` against `build_action_manifest` over
  `all_action_specs` and the test-only `_testing_emit_notifications`). A
  spec added, dropped, or changed on one side alone fails.
- **`spec_schemas.cross.test.ts`** — wire-shape conformance: the responses
  and backend-initiated notifications of zzz's own session, provider-status,
  project, filesystem, and terminal actions parse against their TS
  `spec.output` / `spec.input` (the frontend rejects what doesn't), and
  every void-input method is sent over a WebSocket with `params` both
  omitted and `{}`. `completion_*` needs a live provider and isn't covered.
- **`session.cross.test.ts`** — the per-port session cookie
  (`zzz_session_<port>`: set on login, the shared `fuz_session` name not
  read; fuz_app's hardened-attribute suite runs under it in
  `spine_suites.cross.test.ts`); another session's
  logout closing this session's socket while the session stays valid and a
  fresh socket works (what the frontend's recheck-and-reconnect relies on);
  an RPC `account_session_revoke_all` already committed when the socket
  closes.
- **`project.cross.test.ts`** — project open / list / close on plain
  directories and git checkouts under the temp root, idempotency, scope on
  close (closing a project on `zzz_dir`, on a scoped dir via a
  non-canonical spelling, or nested in a scoped dir keeps write access;
  closing a plain one revokes it), `_testing_reset` closing every project
  and restoring the boot-time scope, `project_open` returning the project
  (`plain_dir` or `git_repo`, focused on its root), the open's `focus`, its
  files (metadata, no contents), `watch_status`, and `refused` (first, concurrent, and
  idempotent open; a file opening its directory; a subdirectory of a
  checkout rooting at the checkout, `.git` unindexed; symlinks and link
  loops skipped; an unreadable subdirectory skipped while its siblings are
  indexed; an unreadable root refused with `forbidden` and nothing
  registered), an untrusted registry (its directory `o+w`) refused with
  `forbidden` / `registry_untrusted`, nonexistent (`not_found`) errors, a
  symlink loop / over-long name (`invalid_params` / `invalid_path`), a NUL
  byte (`params_nul`, refused by the dispatcher before the handler), `.zzz`
  and credential directories refused (`protected_dir_not_allowed` — the
  directory, a subdirectory, a file in it, and a symlink to it, while its
  parent opens with it skipped and its `.env` indexed), the root rules
  (`$HOME`, a symlink to it, its parent, `/`, and `/proc`, `/sys`, `/dev` →
  `root_not_allowed`; a directory outside `$HOME` and the harness's
  allowlisted `os.tmpdir()` → `root_outside_home`), and `project_changed`
  broadcast on open/close (no broadcast on an idempotent open).
- **`project_registry.cross.test.ts`** — runs only in the
  `cross_backend_rust_projects` project, whose backend's `HOME` is a fixture
  directory (`rust_projects_backend_config`), since a registry is trusted
  only below the home directory: a path in a repo opens the registry's root
  with every entry's state (present, missing, and one linking out of the
  root refused `entry_not_confined`), focused on that repo, indexing the
  root's loose files and the focused repo alone (not an unregistered
  directory); the root alone focuses nothing, and a later open of a repo
  adds its focus with a `project_changed` `update`; an open of the root
  requesting a focus (a reopen's shape) lands the present entry and
  refuses the rest per dir in `refused` (`repo_not_present` for one not
  cloned and one refused, `repo_not_in_project` for an unregistered
  directory); `repo_focus` of an
  entry indexes it, replies with that repo's files alone, and notifies
  another socket, which pulls the repo with `repo_files`, again changes
  nothing, and `repo_unfocus` drops it from that socket's next snapshot,
  a later `repo_files` refusing it (`repo_not_focused`); both refuse
  what isn't a present entry (`project_not_open`, `repo_not_in_project`,
  `repo_not_present` as `not_found` for one not cloned and `forbidden` for
  a refused one, `project_not_registry` for a plain directory), and
  `repo_files` what the project doesn't focus — an unfocused entry, the
  root, an unregistered directory (`repo_not_focused`); the whole
  root is in scope while open and out of it once closed; each change —
  open, focus, unfocus, close — stamps a newer rev, which its reply, its
  `project_changed`, a `repo_files` read at it, and `session_load`'s
  `projects_rev` carry, an open that changes nothing keeping the rev
  (`opened` false), and `project_close` answers `{rev}`; a registry its
  other users can write refuses the open (`registry_untrusted`); a path in
  no entry opens as its directory with `fallback` `unregistered` on the
  reply and the `project_changed` `open`, and an invalid registry inside a
  checkout opens the checkout with `fallback` `registry_refused` /
  `registry_invalid`; a checkout holding its own registry with nothing
  cloned opens as the checkout, `unregistered`, from a path in it and from
  its root alike — the root with its focus requested, as a reopen asks;
  `project_status` fills in each present entry's git status and follows an
  edit, refusing a plain directory (`project_not_registry`) and a closed
  root (`project_not_open`).
- **`filesystem.cross.test.ts`** — `diskfile_read` (a text file whole with
  its size and `mtime`, read through to the disk — a same-length rewrite read
  at once, a file in an ignored directory the filer never indexes — a file
  in the app dir, over the size limit →
  `too_large` and not UTF-8 → `not_utf8` with `contents: null` and `hash:
  null`, the BLAKE3 `hash` of a loaded file's bytes, not found,
  out of scope, a `.zzz` home refused however it's spelled and whether or not
  the file exists, a symlink to the file or along its path, a directory, a
  FIFO, a socket, strict inputs), scoped `diskfile_update` / `diskfile_delete`,
  `directory_create` (missing parents created, a taken name `conflict` /
  `already_exists`), writes into `zzz_dir` + nested subdirs,
  path-traversal / out-of-scope / relative-path rejection and the error codes
  (see Filesystem errors), a `.zzz` home refused to `diskfile_update`,
  `diskfile_create`, `diskfile_delete`, and `directory_create` however it's
  spelled and whether or not the path exists (nothing written, created, or
  removed), wrong file kinds (a directory, a FIFO — refused
  without blocking), atomic replace keeping the mode with no temp file left,
  permissions (a read-only file refused, a writable file in a read-only
  directory written in place, a new file there `directory_not_writable`),
  `diskfile_create` never overwriting (`conflict` / `already_exists`),
  `diskfile_update`'s compare-and-swap (a write by another process just
  after a read, before any filer event, refuses the stale `expected_hash`
  with `conflict` / `disk_changed` and leaves the file and no staged file;
  the matching hash writes and answers the written bytes' BLAKE3; a gone
  file and one over the read limit are `disk_changed` with nothing created;
  an off-form hash — uppercase, `blake3:`-prefixed, short, `null` — is
  `invalid_params`), the written bytes' `hash` in every save's response,
  strict inputs, the 16 MiB RPC message cap on both transports (built from
  the frontend's `RPC_MESSAGE_MAX_BYTES`, pinning it to the backend's
  `RPC_MESSAGE_MAX_BYTES`: under it is written, over it is a 413 on HTTP and
  closes the socket on WS), and `filer_change`
  broadcasts in an open project (file create; rename → `delete` of the old
  path + `add` of the new; an mtime-only change, a rewrite of the same
  bytes (with and without a `utimes`), and new contents each → a `change`
  with the new metadata, each
  parsed against the TS spec, no disknode — broadcast, or a file of a
  `project_open` or `session_load` snapshot — carrying contents, each
  file's `size` its bytes, and the contents read back with
  `diskfile_read`).
- **`file_bytes.cross.test.ts`** — the byte routes (`/api/files/bytes`),
  which sit outside the action system, so this suite is what pins their
  posture: reads (whole, `Range` → 206 / 416, HEAD), the response-header
  lockdown (media types only for allowlisted extensions; HTML, SVG, XML,
  scripts, and text as `application/octet-stream` attachments; `nosniff`,
  the sandboxing CSP, `Cross-Origin-Resource-Policy`, `no-store` on every
  response), exclusive create (non-UTF-8 bytes, parents created, a taken name
  `already_exists`), offset-checked append (a retried or skipped chunk is a
  409 `offset_mismatch` carrying the current size; never creates; a FIFO
  with no reader refused, 400 `not_a_regular_file`), path refusals with the
  file actions' reasons (a FIFO read refused too), a `.zzz` home refused on
  every method (403 `protected_dir_not_allowed`, whether or not the file
  exists, nothing written), the body cap (built from the
  frontend's `FILE_BYTES_MAX_BODY_BYTES`, pinning it to the backend's), and
  the gates — a malformed query refused before auth, 401 without a
  credential on every method, 403 for an origin off the allowlist, a session
  request with no `Origin` served (a media element's `src`), a full-scope
  bearer admitted, a method-scoped one refused (`token_scope_required` /
  `surface:file_bytes`).
- **`browser_gates.cross.test.ts`** — the gates in front of every route:
  loopback `Host`s served; a foreign `Host` (a DNS-rebinding page's) refused
  with 403 `forbidden_host` on health, the static fallback, account status,
  RPC GET and POST, the byte routes, and a WebSocket upgrade; a page on
  another `localhost` port (same-site, so it carries the cookie) refused with
  403 `forbidden_origin` on RPC — a forged `text/plain` POST included — and
  the upgrade, while zzzd's own origins are allowed a JSON POST; a `POST` a
  browser sends cross-origin without a preflight (no `Content-Type`, or
  `text/plain`, form-encoded, or multipart) refused with 415
  `unsupported_content_type` on RPC — with a session and an allowed origin,
  the forged request's exact shape — and on a byte-route create, which
  writes nothing; a foreign `Origin` refused on health, the static fallback,
  and unrouted paths; and a body declared over its route group's cap answered
  413 from a foreign origin on every group (health, the fallback, an account
  route, RPC, the byte routes). Requests go through `node:http`, since `fetch` won't send a
  chosen `Host`.
- **`dev_origins.cross.test.ts`** — a second backend started with the dev
  env template's `FUZ_ALLOWED_ORIGINS`, as `cargo xtask dev` runs `zzzd`:
  the Vite dev server's pinned origin reaches a handler, and every other
  local origin (a default Vite port, `vite preview`'s, the dev port under
  another loopback name, the backend's own port) gets the gate's 403 on
  RPC, REST, and the WebSocket upgrade.
- **`media.cross.test.ts`** — the media actions and jobs against the
  daemon's real tools; each test that needs one skips, visibly, without it
  (`ffmpeg` on `PATH`; for transcription also whisper.cpp and
  `ZZZ_WHISPER_CPP_MODEL` in the environment the tests run in, which the
  daemon inherits). `media_finalize`: a
  streamed `.webm` with no duration gets one, replaced in place with its
  mode kept and an output matching the spec; text, a concat script, and a
  playlist dressed as `.webm` are refused (`media_invalid`, with the tool's
  stderr) and left untouched; an unsupported extension
  (`unsupported_media_type`), an out-of-scope or missing path, and an
  unauthenticated caller are refused. `transcription_create`: refused up
  front for a non-audio extension, a relative path, a bad `language`, or an
  unknown key; `tool_unavailable` on a machine with no speech model; with
  one, a clip is transcribed to its sidecar — the `job_changed` and
  `transcription_progress` notifications and the outputs parse against
  their specs, the sidecar parses as a `Transcript` with the source's name,
  size, blake3, and duration, neither recorded command line contains the
  file's path, the scratch directory is left empty, the job is in
  `session_load`, and a second run is `already_exists`; a non-audio file
  fails the job with the tool's stderr and no sidecar; a queued job
  cancelled never starts and the running one is stopped, both without a
  sidecar or scratch left behind; another account can neither see nor
  cancel them; `job_cancel` of an unknown id is `job_not_found`.
- **`terminal.cross.test.ts`** — PTY create / read / write / close lifecycle,
  `terminal_data` / `terminal_exited` notifications over WS, live resize and
  out-of-range resize rejection, explicit cwd and bad-cwd spawn failure,
  a nonexistent command refused before any terminal is registered
  (`invalid_params`, `terminal_command_not_found`), a relative `cwd` and
  unsupported close signals refused (`invalid_params`), a ~22KB paste round-trip through `cat`
  (partial writes continued), multibyte output split across reads, env
  scrubbing (no `SECRET_*` / `DATABASE_URL` / … in the child), reaping of a
  child that ignores `SIGTERM` + `SIGHUP` (no zombie after close),
  `not_found` for a missing terminal ID (close included), ownership scoping (a second
  account gets no output, can't drive or close the terminal, and gets
  replies identical to an unknown id's; the owner's second socket does get
  output), output pacing (after a first `terminal_ack` and no more, output
  stops within one read of the 1 MiB window with the process blocked, a
  resize still answers, an ack that leaves less than the frontend's ack
  threshold outstanding resumes it, and acking lets the rest through; several
  windows of output reach a client that never acks, or acks only over HTTP),
  `session_load`'s `terminal_ids` (running listed; exited, closed,
  and other accounts' not), and a self-deleted account's terminal processes
  being reaped.
- **`provider.cross.test.ts`** — `provider_load_status` (no-key status) plus `session_load`
  (zzz_dir file listing with size and no contents, the contents read with
  `diskfile_read` + recursive subdirectory walk; `file_roots`
  covering `zzz_dir`, the scoped dirs, and every file; a stable
  `server_instance_id`; a file's tuple sent without its `ctime` where it
  equals the `mtime`, and with it where a `utimes` moved them apart).
- **`completion.cross.test.ts`** — `completion_create` on a provider with no
  API key (`ai_provider_error`, -32020 / 502) and blank-prompt rejection.
- **`static.cross.test.ts`** — built-frontend serving through the full
  router: the `cross_backend_rust` backend serves a miniature adapter-static
  build (`STATIC_FIXTURE_FILES` in `zzz_backend_config.ts`, via
  `ZZZ_STATIC_DIR`); covers root / prerendered pages (incl. `docs.html` beside
  a `docs/` dir), the `200.html` fallback for dynamic routes and
  `?open=` queries, HEAD, cache headers, and the 404s for missing
  `_app/` assets and backend paths. `static_files.rs` unit tests cover the
  same resolution plus path traversal.
- **`proxy.cross.test.ts`** — runs only in the `cross_backend_rust_proxy`
  project (backend booted with `ZZZ_TRUSTED_PROXIES=127.0.0.1`, which can't be
  flipped mid-run). Each test triggers a failed login under a unique username
  and asserts the resulting `audit_log.ip` matches the expected resolved client
  IP for a given `X-Forwarded-For` + connection-IP combination (no-XFF,
  trusted/untrusted hops, malformed entries, IPv6, IPv4-mapped normalization,
  leftmost fallback). The resolution itself is `fuz_http::client_ip_middleware`
  (spine crate), where the pure functions carry their own `#[cfg(test)]` unit
  tests.

## Known Issues

- **No per-message WS session revalidation** — a socket is authorized at
  upgrade, where the spine re-reads its credential once more at admission
  (`fuz_actions::admit_upgrade`: registered pending → re-read → admitted; a
  credential revoked mid-upgrade closes with 4001, a failed re-read with 1011).
  After that, closes are event-driven: every revocation closes the matching
  connections (`close_connections` on a `ConnectionCloseTarget`), and the
  auth cleanup closes an expired session's within one interval. A message on
  an open socket never re-checks its session.
- **error.data omits validation details** — for -32602 (invalid params)
  errors, `error.data` omits the schema issues for security (no schema leak to
  unauthenticated callers). The integration test `normalize_error_data`
  function tolerates either shape. Future: env-conditional — include the
  issues in dev, strip in prod.
- **filer skips symlinks** — the walker and event handling never follow or
  index a symlink (file or directory), and no watch is added through one
  (watches go only on real directories the walker lists), consistent with
  `ScopedFs`'s no-symlink rule.
  This keeps link loops (`up -> ..`, a Wine prefix's `dosdevices/z: -> /`)
  from hanging the scan and keeps files outside the watched root out of the
  index. A symlinked file or directory inside a project is invisible in
  the file tree.
- **text read cap** — the filer reads no file: its index is metadata only
  (identity, size, timestamps, the `lstat` stamp), so its memory scales with
  the number of files, not their bytes. `diskfile_read` returns text up to
  4 MiB (`MAX_TEXT_READ_SIZE` in `crates/zzz_server/src/handlers/filesystem.rs`);
  a larger file, or one not UTF-8, comes back with `contents: null` and its
  `unloaded_reason`. The frontend treats a file whose read finds no text or
  fails as `unloadable`: read-only, never saved over (see
  ./architecture.md § Known Limitations). A loaded file's save fits the 16 MiB RPC
  message cap except in the worst case (JSON escapes each control character
  to 6 bytes), where the client guard refuses it cleanly.
- **filer skips non-UTF-8 paths** — a file or directory whose name isn't
  valid UTF-8 is skipped with its whole subtree, by the walker and in event
  handling (`is_ignored`), rather than indexed under a lossy U+FFFD key no
  client could address.
- **Filer ignore rule** (`filer::ignore`) — `IgnoreRule::FixedNames`
  (`ALWAYS_IGNORED_DIRS` plus `PLAIN_DIR_IGNORED_DIRS` by name) or
  `IgnoreRule::Git` (`ALWAYS_IGNORED_DIRS` by name plus an `IgnoredSet` of
  absolute paths, its pruned dirs kept apart from its ignored files),
  decided once at `start_filer` (`initial_rule`) from the root alone, so one
  filer serves every lifetime and project sharing its root: git's for a root
  that is a checkout (`project::is_checkout`) at `FilerDepth::Tree` when
  `FilerConfig::git` is set (`FilerManager` sets it from `App.git` when
  `App.git_usability` is usable) and the first listing succeeds; fixed names
  otherwise, with a warning for a checkout. The set is `fuz_git`'s
  `ls_ignored` plus one `check_ignore` over its folded dirs
  (`GitRoot::prune`), the confirmed dirs pruned whole and the listed files
  skipped one by one; a `./`-alone listing is the dir ignored whole. Each
  listing is taken again after its walk — the start's, a re-prune's, a new
  dir's (`FilerState::relist`) — and what the second adds is dropped from
  the walk's result with the watches it added: a file created between the
  listing and the walk would otherwise be indexed unvetted, and its later
  events skip it as indexed. It's shared (`SharedRule`: an `Arc` snapshot
  behind a `parking_lot::RwLock`, plus a version) by the notify callback,
  the walks, and the event loop, its only writer. The walk also skips a dir
  holding a repo of its own (`is_nested_repo`: any `.git` entry — a dir,
  gitfile, or symlink, even one git wouldn't read as a repo — makes the dir
  a repo of its own here), and reports each one it stopped at
  (`DirScan::nested`): the `SharedRule` keeps them beside the rule, each
  sync replacing those at and under the dir it walked (`set_nested_under`) —
  so the start's walk, a rescan, and the sync a `.git` appearing triggers
  (`RuleMarker::RepoDir`) keep the list current, a dir gone or no longer a
  dir drops those under it (`remove_children`), and a nested `.git` removed
  is seen at the next rescan (no watch is in the repo) — under the same
  version, so a change is one the wire sees. Live, the event loop drains
  each burst and vets its adds of paths not yet indexed
  (`FilerState::vet_adds`: one `check_ignore`, a missing path asked about as
  a file, a path that turned into a dir re-asked, an ignored dir's path
  that's a file now asked about as the file, then an `ls_ignored` scoped to
  each new dir git doesn't ignore); a path inside an unpopulated submodule,
  which git refuses, drops that submodule's paths from the batch and asks
  again — once per distinct submodule, up to `CHECK_MAX_SUBMODULES` (8) —
  leaving each unindexed until the next re-prune. A scan's new files no
  event vetted (a `session_load` rescan, a degraded poll) get one
  `check_ignore` too (`vet_scanned`), re-pruning when one of them sits in a
  watched dir — a dir no event vetted, such as one a `.git` left, which a
  listing would prune whole. Both vet at most `VET_MAX_PATHS` (128) paths
  and re-prune past it: git's check costs about 1.8 µs per path per index
  entry, so on a 160k-entry index (sparse wpt) 1024 paths took 1.8 s against
  the 2 s `CHECK_TIMEOUT`, while a re-prune of that tree takes about 0.3 s —
  the cheaper past about 150 paths. A `.gitignore` event (passed through the
  callback's filter even when ignored itself, `rule_marker`) or an
  `info/exclude` change (the filer's own watcher keeps a fixed watch on
  `<root>/.git/info/`, `DirWatches::watch_git_info`, through every reset; a
  gitfile root isn't watched), or a `.gitignore` a scan finds changed,
  requests a re-prune once the changes settle (`REPRUNE_SETTLE` 400 ms of
  quiet, at most `REPRUNE_SETTLE_MAX_WAIT` 5 s), bursts dropped meanwhile
  (the watches their removes and renames took dropped with them, as applying
  them would); a failed or oversized vetting — more than `VET_MAX_PATHS`
  (128) paths, more than `VET_MAX_NEW_DIRS` (8) new dirs, or paths still
  turning into dirs after `VET_ROUNDS` (3) asks; a failed one drops those
  watches too — an overflow, and the set outgrowing `LIVE_ADDED_MAX` request
  one at once. A re-prune runs inline on the event loop after the current
  step (`FilerState::reprune`): it relists, swaps the set, rescans the root
  without vetting, and lists again, broadcasting the diff — inline because
  the loop is the index's only writer, and a re-prune beside it would race
  the events applied meanwhile. A start whose second listing un-ignores
  something the first ignored re-prunes as its loop starts (the walk skipped
  it before any watch could see the excludes file change). One whose listing
  fails or times out keeps the last set until the next trigger: an edit, an
  overflow, a rescan that asks for one, or — while that failure is the last
  word — the next `session_load` rescan or degraded poll, each of which
  re-prunes in place of its rescan (`FilerState::reprune_if_failing`). So
  the rule change it was for stays unapplied until the next load or poll at
  the latest. Its own rescan vets what it finds, and new files git can't vet
  there stay unindexed until a pass vets them; what that rescan requests is
  dropped, so a failure never retries itself and `REPRUNE_MAX_FAILURES`
  counts separate triggers — any re-prune a change on disk asked for: a rule
  edit, lost events, new files git couldn't vet, or a set grown past its
  budget (`RepruneTrigger::Change`). A load's or poll's retry that fails
  doesn't count (`RepruneTrigger::Retry`), so reloads alone never give up
  git's rule, and a git that never answers costs a listing's timeout per
  degraded poll and per load until such changes fail too — on a quiet
  degraded tree, possibly never. Each load waits out that 5 s with the
  filer's loop blocked; the polls are bounded by
  `DEGRADED_RESCAN_COST_FACTOR`, which spaces them by ten times their own
  duration — about 50 s apart, roughly a 10% duty cycle. That many counted
  failures in a row, or a root no longer the checkout it was, fall back to
  fixed names for good. Every git call runs on `spawn_blocking` with the
  root's parent as discovery ceiling, `refuse_implicit_bare`, and a timeout
  (`LIST_TIMEOUT` 5 s per listing call, `CHECK_TIMEOUT` 2 s per vetting call
  — a FIFO `.gitignore` stalls git until it), after re-checking that the dir
  it runs in is still the real, canonical directory and the root still a
  checkout (`GitRoot::check_confined`). A burst's vetting can stall the loop
  for a check, a listing, and the re-prune's listing in turn — about 12 s
  when git never answers. `session_load` waits on every filer's rescan
  (`FilerManager::rescan_all`) with no timeout, so a git root stalled that
  way delays every client's `session_load` by up to the stall's bound — and,
  while a re-prune has failed, by the re-prune it runs in place of the
  rescan.
- **Ignored paths on the wire** — `Filer::ignored_on_wire` is the set as an
  open project carries it (`filer::IgnoredPaths`: the paths relative to the
  root, sorted, dirs with a trailing `/`; `nested`, the repos of their own
  the walks stopped at and the unpopulated submodules, relative, sorted,
  each with a trailing `/` (`IgnoredSet::nested_on_wire`) — both cached per
  rule version; and the resync count, `resyncs` on the wire), `None` on
  fixed names. Every `ProjectManager` commit, after ensuring its filers and
  under the lock, reads it for every focused dir of every project in the
  next state (`refresh_ignored_of`, through `FilerManager::ignored_on_wire`,
  which also marks each filer on or off the wire) — lock order: the projects
  mutex, the filer map (read), each filer's rule (read), as `focused_files`
  takes them. A project whose set moved is a change (`OpenProject::ignored`
  is in the state's equality): stamped and broadcast as `update`, even by a
  commit its caller meant as a no-op. A filer whose set changes on its own
  signals from its event loop, between whole steps — the rule's version or
  the resync count moved since the last signal — through a coalescing flag
  (`RescanSignal`, as the overflow rescan uses) to a publisher task per git
  filer (`publish_ignored_changes`), which calls
  `FilerConfig::on_ignored_change` at once and then at most every
  `IGNORED_REFRESH_INTERVAL` (1 s): live vetting changes the set a file at a
  time, and each refresh resends every changed project's whole set. The hook
  (`FilerManager`'s, holding the app weakly) spawns
  `ProjectManager::refresh_ignored` — the open projects committed unchanged
  — on a task of its own, since a commit may stop the filer whose publisher
  called it (aborting that task) and must run to completion; the filer never
  awaits the projects mutex. **The flood guard**: a re-prune that would
  queue more than `REPRUNE_BROADCAST_MAX` (1024) `filer_change`s on a filer
  on the wire queues none, drops those paths' pending changes (a stale one
  after the client's pull would undo it), and bumps the resync count, which
  the loop then signals; each client sees the count move and pulls the dir
  (`repo_files`), reading the index the re-prune left. 1024 changes are
  about 350 KiB per socket — about one `repo_files` reply of a repo of a few
  thousand files — far under the 32 MiB socket budget (about 95,000). Off
  the wire (a permanent filer alone) nobody would pull, so every change is
  sent.
- **Filer watches** — each filer adds one non-recursive notify watch per
  directory it indexes, from its own walk (`filer::watches::DirWatches`), so ignored,
  symlinked, and non-UTF-8 directories and the app dir get none — the watch
  budget scales with what's indexed, not with `node_modules/` or `target/`.
  Each directory is watched before it's listed, so an entry created in
  between is either listed or reported; a directory that appears (created,
  renamed in, recreated) gets watches for its subtree during its sync, and
  one that's removed or renamed away has its watches dropped. The walk and
  the watch calls (a round trip to notify's watcher thread each) run on
  blocking threads. Watches are reference-counted by inode: two paths naming
  one directory (a renamed directory's old and new path before the old is
  dropped, a bind mount) share one kernel watch, removed only with its last
  path. Failures are per directory: an unreadable directory is skipped and
  logged once (its parent's watch reports a chmod that makes it readable,
  which syncs it; a watched directory chmod'ed unreadable is re-checked on
  that report and drops out of the index), a vanished one ignored, and one
  whose listing fails transiently (`EMFILE`, `ENOMEM`, `EIO` — anything but
  `EACCES` / `ENOENT` / `ENOTDIR`) keeps what's indexed under it and is
  polled until it lists; only a root that can't be listed fails
  `start_filer` (`project_open` → `forbidden` / `not_found`). A running
  filer whose root goes missing polls it until it's back. An overflow
  (dropped events, or inotify's queue overflow) replaces the watcher with a
  fresh one and re-adds every watch during the rescan, since neither the
  bookkeeping nor notify's own path map survives lost events. The watcher
  comes from a factory (`WatcherFactory`) that holds the event channel's
  sender, so the event loop runs — polling, answering rescans — even with
  no watcher. **Degraded mode**: past the watch limit (inotify's `ENOSPC`
  from `max_user_watches`, `FilerConfig::watch_limit`, or no watcher at all
  — e.g. `max_user_instances`), the remaining directories are listed
  unwatched and the index still comes from the scan; the topmost unwatched
  directories are rescanned every `DEGRADED_RESCAN_INTERVAL` (5s, or 10x the
  last rescan's duration if longer), retrying their watches, and
  `Filer::watch_status` reports `Degraded` (returned by `project_open` as
  `watch_status` — degraded when any of the project's filers is — kept on
  the opening tab's `Project` cell and shown on the projects page and in
  the desk menu). A limit hit stops watch attempts
  until the next rescan. A filer that degrades or recovers after
  `project_open` returns is only logged — no notification carries the
  change. **Change by stamp**: watch events and rescans (`session_load`,
  overflow, degraded polling) alike decide from a file's `lstat` stamp
  (`filer::index::FileStat`: dev, inode, size, mtime, and `st_ctime`, the inode
  change time — not the wire `ctime`, which is the birth time) — a file
  whose stamp matches its indexed one is unchanged and not broadcast, any
  other is a `change` (a `touch` and a rewrite of the same bytes included,
  and a chmod, chown, xattr write, or new hard link, which move only
  `st_ctime` and so broadcast unchanged wire metadata — accepted). Following
  git's "racily clean" rule, a stamp is only trusted when its `st_ctime` lay
  more than `RACY_STAT_MARGIN` (3s) before it was taken (the clock is read
  before the `lstat`), since same-size writes inside one timestamp tick leave
  every stamp unchanged — a tick is often a jiffy, whole seconds on some
  filesystems (ext3, some FUSE and network ones), two seconds on FAT, and
  inode times come from a coarse clock that lags the wall clock by up to a
  jiffy. Only `st_ctime` counts: every write, truncate, and `utimes` moves
  it and userspace can't set it (on a kernel-managed filesystem), so an
  `mtime` in the future (`touch -d`, `cp -p`, an archive from a clock ahead)
  doesn't keep a file untrusted. A
  file indexed under an untrusted stamp is a `change` the next time an event
  or a rescan looks at it, whether or not the stamp moved; that look takes a
  trusted stamp once `st_ctime` is past the margin. A spurious `change`
  costs a client holding the file one `diskfile_read` that finds the same
  text. A write the stamp can't see goes unnoticed until it next moves (see
  ./architecture.md § Known Limitations).
  `FilerManager::start_filer` gates starts per path, so concurrent opens of
  one directory share a single initial scan. On macOS `FSEvents` each watch
  call restarts notify's stream, so per-directory watching is slow there on
  large trees.

## Design Decisions

- **DB**: `tokio-postgres` + `deadpool-postgres` pool in `App`. Required at
  startup — server fails fast if `DATABASE_URL` is missing or unreachable.
  Migrations run on every startup (CREATE TABLE IF NOT EXISTS).
- **Credentials**: cookie signing, session and API-token hashing, and
  password hashing are `fuz_auth`'s, byte-compatible with fuz_app's formats;
  `zzz_server` holds no credential crypto of its own (its one direct hash is
  the transcription `blake3`).
- **Large responses**: `session_load`, `project_open`, `repo_focus`, and
  `repo_files` carry indexed files' metadata, never contents, so a large
  tree is a large reply. Each returns a typed `fuz_actions::ActionOutput`
  (`ActionSpec::new_output`) that the spine serializes once, straight into
  the response body, sized up front (`SnapshotFiles::json_size_hint`) —
  no `serde_json::Value` copy. The files go out compactly
  (`filer::SnapshotFiles`, twin of `SnapshotFiles` in `diskfile_types.ts`):
  one `{dir, files}` group per filer dir (`source_dir`), each file a tuple
  `[rel, size, mtime, ctime?]` with its path relative to `dir`, and
  `ctime` (the birth time) left off when it equals `mtime`, as it is for
  nearly every file. Typescript's checkout (about 81k files) focuses in a
  7.2 MiB reply rather than the 16.5 MiB of disknode objects. Timestamps
  everywhere — snapshots, `filer_change`, `diskfile_read` — are whole
  milliseconds since the epoch: nothing reads finer, since whether a file
  changed is its `lstat` stamp's call (to the nanosecond, never on the
  wire), and a client compares a timestamp only for equality. The frontend
  decodes a reply's groups back to disknodes (`decode_snapshot_files`)
  before `Diskfiles.reconcile` / `add_initial`; `filer_change` keeps the
  disknode object.
- **Strict inputs**: every zzz handler decodes `params` through
  `fuz_http::parse_strict_params` into a `#[serde(deny_unknown_fields)]`
  struct mirroring its strict `object` TS input (unknown keys and explicit
  `null`s are `invalid_params`; nested `optional` fields refuse `null`
  through a `present` deserializer; UUID fields use
  `fuz_http::deserialize_wire_uuid`), and the `z.void()` methods (`ping`,
  `session_load`, `project_list`) declare `InputShape::Void`, so the
  dispatcher refuses any declared key before the handler runs — an absent
  `params` and a `{}` are both the no-arg call, since fuz_app's WebSocket
  client sends `{}` for a parameterless request. Every other spec declares
  `InputShape::Object`.
- **Filesystem errors**: `handlers::filesystem::scoped_fs_error` maps each
  `ScopedFsError` by cause, with `data.reason` set to an `ERROR_*` constant:
  a relative / NUL path, a directory or special file where a file was
  expected, or a non-directory where one was expected → `invalid_params`
  (-32602; `invalid_path`, `is_a_directory`, `not_a_regular_file`,
  `not_a_directory`); out of scope, a symlink, an OS permission refusal
  (including a read-only target file or filesystem), or a new file or
  directory in a non-writable directory → `forbidden` (-32002;
  `path_not_allowed`, `symlink_not_allowed`, `permission_denied`,
  `directory_not_writable`); a missing path → `not_found` (-32003;
  `path_not_found`); `diskfile_create` or `directory_create` over an
  existing path, a save whose file was replaced mid-save, or a save whose
  file no longer holds the bytes its `expected_hash` names → `conflict`
  (-32004; `already_exists`, `replaced_during_save`, `disk_changed`, and the
  byte routes' `offset_mismatch`); any other I/O failure → `internal_error`
  (-32603, no reason). Messages keep the `failed to … : …` prefix.
  `project_open` carries the resolver's `ProjectError::reason`
  (`handlers::project::open_error`): missing → `not_found` /
  `path_not_found`; a relative path, a symlink loop, or an over-long name →
  `invalid_params` / `invalid_path` (a NUL byte never reaches it —
  `params_nul`); a path the OS refuses → `forbidden` / `permission_denied`;
  a registry that can't be read or doesn't parse → `invalid_params` /
  `registry_unreadable`, `registry_invalid`; an untrusted or unconfined one
  → `forbidden` / `registry_untrusted`, `registry_not_confined`; one
  replaced while it was checked → `conflict` / `registry_changed` — each but
  the last falling back instead for a registry kept inside a checkout, no
  link above naming it, to a checkout at or below its directory (the
  project's `fallback`, `registry_refused` with that reason;
  ./architecture.md § Projects → Fallbacks); an unusable walk bound →
  `internal_error` / `bound_unusable`; the root or the path's own focus
  whose listing is refused → `forbidden` / `permission_denied`. A refused
  registry entry fails nothing: its `entry_*` reason is on the entry. Nor
  does a focus the open requested (`focus`) that doesn't land: each is
  reported in the reply's `refused` with the reason `repo_focus` would give
  it (`handlers::project::focus_refusal_reason` — `repo_not_in_project`,
  `repo_not_present`, `project_not_registry`, `permission_denied`), or
  `repo_index_failed` (`ERROR_REPO_INDEX_FAILED`) for a listing that failed
  otherwise, the one a client retries. On canonical paths, so no symlink or
  `..` spelling gets around either, it holds the opened directory and the
  project root to the root rules (`root_policy::RootPolicy::admit`: strictly
  inside `$HOME` or in `ZZZ_ROOTS_OUTSIDE_HOME`, never `/`, `$HOME` or an
  ancestor of it, or under `/proc`, `/sys`, `/dev`) — `forbidden` /
  `root_outside_home` (`root_policy::ERROR_ROOT_OUTSIDE_HOME`) where the
  allowlist would admit it, else `root_not_allowed`
  (`ERROR_ROOT_NOT_ALLOWED`) — and refuses a path that is, or is inside, a
  protected directory (`scoped_fs::protected_dir`): a credential directory
  (`.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.password-store` —
  `scoped_fs::CREDENTIAL_DIR_NAMES`) or a directory named `.zzz` other than
  the app dir (the CLI's daemon home holds `.env` and `bootstrap_token`),
  with `forbidden` / `protected_dir_not_allowed`
  (`handlers::filesystem::ERROR_PROTECTED_DIR_NOT_ALLOWED`; the message
  names which directory). Every `ScopedFs` operation refuses a path in one
  the same way, whatever root covers it
  (`ScopedFsError::ProtectedDirNotAllowed` — the file actions, the media
  actions, and the byte routes, where it's a 403): its path validation
  checks the lexically normalized path (`.` and `..` resolved — the symlink
  checks after it make that the path acted on) before the roots and before
  anything touches the filesystem, so the refusal doesn't say whether the
  path exists. The app dir and its contents pass the `.zzz` rule (a
  credential directory has no exception; the boot refuses an app dir in
  one). A filer started on such a root refuses too
  (`FilerConfig::root_protected`); a scoped dir there, or one the root rules
  refuse, fails boot before any filer starts (`PUBLIC_ZZZ_SCOPED_DIRS`
  below). `project_close`, `repo_focus`, or `repo_unfocus` of a root that
  isn't open → `invalid_params` / `project_not_open`
  (`handlers::project::ERROR_PROJECT_NOT_OPEN`). `repo_focus` /
  `repo_unfocus` on a checkout or plain directory → `invalid_params` /
  `project_not_registry`, of a directory that's none of the registry's
  entries → `invalid_params` / `repo_not_in_project`; `repo_focus` of an
  entry not cloned, or gone since the registry was resolved → `not_found`,
  or refused → `forbidden`, all `repo_not_present`; a repo whose listing
  fails otherwise → as for `project_open`'s focused directory, the message
  `failed to focus repo: …`. `project_status` of a root that isn't open →
  `invalid_params` / `project_not_open`, of a checkout or plain directory →
  `invalid_params` / `project_not_registry`. `repo_files` of a root that
  isn't open → `invalid_params` / `project_not_open`, of a directory the
  project doesn't focus → `invalid_params` / `repo_not_focused`
  (`handlers::project::ERROR_REPO_NOT_FOCUSED`) — never an empty answer,
  which an empty repo would read as. The check and the read happen under the
  projects' lock (`ProjectManager::focused_files`): a commit stops or
  narrows filers before it publishes, so a read checked against the
  published snapshot could find a filer already stopped (no files) or
  narrowed (a nested registry's top level alone).
- **Atomic writes**: `ScopedFs::write_file` stages content in a hidden
  `.zzz-tmp-<uuid>` file beside the target (`O_EXCL | O_NOFOLLOW`), gives it
  the replaced file's mode minus setuid/setgid (zzz always drops them — the
  content changed) and (best-effort `fchown`) owner +
  group, writes, fsyncs, renames it over the target, and fsyncs the directory
  (best-effort), all on a blocking thread; the temp file is removed on any
  failure. So `ENOSPC` / `EFBIG` / a crash leave the old file intact, and
  concurrent saves to one path never interleave (the last rename wins — no
  per-path lock needed). The filer ignores `.zzz-tmp-*` names
  (`scoped_fs::is_temp_file_name`), so only the publishing rename is indexed
  and broadcast. An existing target must be a regular file — a directory,
  FIFO, socket, or device node is refused before anything is opened (a FIFO
  would otherwise block the write, holding a pooled DB connection and a
  blocking thread). Trade-offs: the result is a new inode, so **hardlinks are
  broken** (other names keep the old content) and xattrs / ACLs aren't
  carried over; a file owned by another user becomes the daemon user's when
  `fchown` isn't permitted. An existing target must be writable by the
  daemon — checked by opening it for writing (no create, no truncate), since
  a rename needs only the directory's permission and would otherwise replace
  a read-only file — else `permission_denied`. **In-place fallback (not
  atomic):** when the rename can't happen but the file is writable — the
  directory isn't writable (no temp file), or the rename fails `EBUSY` (a
  bind-mounted file), `EXDEV`, or `EPERM` (a sticky directory) — the content
  is written through that handle: truncate, write, fsync (inode, mode, owner,
  and hardlinks kept; a failure midway leaves the file truncated or
  partial). It first checks the path still names the opened file (`fstat`
  `(dev, ino)` against a fresh `lstat`); a file replaced or removed
  externally since the open fails with `conflict` / `replaced_during_save`
  rather than writing into an unreachable inode. A new file in a non-writable
  directory is `directory_not_writable`.
  **Compare-and-swap:** a `diskfile_update` with an `expected_hash` (the
  `hash` of the `diskfile_read` the edit is based on — BLAKE3, bare 64
  lowercase hex, `handlers::filesystem::content_hash_hex`; an off-form value
  is `invalid_params`, never case-folded) passes `ScopedFs::write_file` an
  `ExpectedContent`. The file must exist (no parent directory is created),
  and after the content is staged — right before the rename, and on the
  in-place fallback right before the truncate — `check_unchanged` opens it
  like a read (`O_NOFOLLOW | O_NONBLOCK`, regular files only), refuses one
  over `MAX_TEXT_READ_SIZE` unread, and hashes at most one byte past it; a
  mismatch, an over-size file, or a missing one removes the staged file and
  fails `conflict` / `disk_changed` (`ScopedFsError::DiskChanged`). It reads
  the disk, never the filer's index, so a write no `filer_change` has
  reported yet is caught. The response is `{hash}`, the BLAKE3 of the bytes
  written (hashed on the request's task — at most a message's worth, which
  the spine parsed there too), so the client's next save has its base
  without a read. A write landing between the compare and the rename (or
  truncate) is still replaced: nothing locks against another process.
  `diskfile_read`'s output carries the same `hash` of the bytes it read,
  `null` with `contents`.
  Errors always name the target, never the temp file. A crash can orphan a
  staging file: the filer's walk deletes exact `.zzz-tmp-<32 hex>` names
  that are regular files last modified over an hour ago
  (`scoped_fs::ORPHANED_TEMP_FILE_MIN_AGE`), and nothing else — staging files
  inside ignored directories aren't reached. `diskfile_create`
  (`ScopedFs::create_file`, used by the editor's "new file") creates the
  final name `O_CREAT | O_EXCL | O_NOFOLLOW` and fails with `already_exists`
  rather than overwriting; a failed write removes the file it created.
  `directory_create` (`ScopedFs::create_dir`, the "new folder") likewise
  creates missing parents but fails with `already_exists` when anything
  holds the final name (`mkdir(2)` is exclusive) — for both, a symlink there
  is `symlink_not_allowed` (path validation refuses it first), and a missing
  parent under a read-only ancestor is `permission_denied`. `rm` and `create_dir` stay
  plain `tokio::fs` calls (unlinking a FIFO doesn't open it).
- **Text reads**: `diskfile_read` answers from one handle.
  `ScopedFs::open_file` opens it `O_NOFOLLOW | O_NONBLOCK` and `fstat`s it
  (a directory, FIFO, socket, or device node is refused without blocking),
  and a bounded read (`read_text_contents`, beside the handler) reads it,
  with nothing cached — every read is of the disk as it is now, whether or
  not the filer has seen the latest write: a file over `MAX_TEXT_READ_SIZE`
  (4 MiB) when opened isn't read, the read stops one byte past the limit for
  one that grew since, and bytes that aren't UTF-8 are dropped; either way
  `contents` is `null` and `unloaded_reason` says which (`too_large`,
  `not_utf8`). The timestamps come from the `fstat` taken before the read,
  so a write racing the read leaves them older than the contents, never
  newer, and `size` is the contents' length when they're loaded, so the two
  agree. Any regular file in scope is readable, indexed or not, except one in a
  `.zzz` home, which `ScopedFs` refuses (Filesystem errors above).
- **File byte routes**: `file_bytes.rs` mounts `GET` / `HEAD` / `POST` /
  `PATCH` on `/api/files/bytes` (`file_bytes::FILE_BYTES_PATH`), taking the
  file as an absolute `?path=`. They exist because the file actions carry
  contents as UTF-8 strings inside one capped JSON-RPC message, which fits
  neither media nor a file that grows as it's written. They are plain axum
  handlers, **outside the action system**: no audit row, no actions-log
  entry, no generated client, and no entry in the `any_credential_surface`
  census — so they run the gates themselves and
  `file_bytes.cross.test.ts` pins them.
  - **Gates**, in order, through the server's `fuz_auth::AuthGate`: the
    origin check (`check_origin`, 403 `forbidden_origin`); query shape
    (unknown key, missing `path`, a non-decimal `offset` → 400
    `invalid_query_params`, the same with or without credentials); the
    credential walk (`resolve_credential` on the origin check's witness — any
    credential, like every zzz-owned action; none → 401); the token scope (a
    method-scoped API token holds no non-RPC surface → 403
    `token_scope_required` / `surface:file_bytes`). The routes are their own
    stack group, capped at `FILE_BYTES_MAX_BODY_BYTES` (equal to
    `RPC_MESSAGE_MAX_BYTES`) outside the `Host`, origin, and simple-request
    gates, so a `POST` must carry a type that isn't form or text (the
    frontend sends `application/octet-stream`) — `PATCH` is always
    preflighted. A request
    with no `Origin` passes the allowlist, which is what lets a media
    element's same-origin `src` load; the session cookie is `SameSite=Strict`,
    so a cross-site page's request carries no credential. A write's body is
    read only after the gates pass.
  - **Read** (`ScopedFs::open_file`, `O_NOFOLLOW | O_NONBLOCK`, regular
    files only): the whole file, or one `Range: bytes=` range (`a-b`, `a-`,
    `-n`) as a 206; a range starting at or past the end is a 416; several
    ranges, another unit, or a malformed spec are ignored and the whole file
    served. The body streams from the open handle in 64 KiB reads — a file
    that shrinks underneath ends the body early, one that grows is cut at the
    length promised.
  - **Serving bytes never executes them.** A project's file is untrusted
    content, and a document rendered on zzz's origin could script the app. The
    `Content-Type` comes from a fixed extension allowlist
    (`file_bytes::media_content_type` — raster images, audio, video; never
    HTML, SVG, XML, PDF, or text) and never from the bytes; everything else is
    `application/octet-stream` with `Content-Disposition: attachment` (the
    name percent-encoded). Every response a handler builds — a read (200,
    206, 416), a write's reply, a `ScopedFs` error — carries
    `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
    'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, and
    `Cache-Control: no-store` (a path's bytes change under it, and no
    validators are sent). A refusal at a gate does not: the 400 for a bad
    query, the 401, the scope 403, the 413, and the Origin layer's 403 are the
    spine's plain JSON errors, returned as they come.
  - **Protected directories**: a path inside a credential directory or a
    `.zzz` directory other than the app dir is refused on every method (403
    `protected_dir_not_allowed`), even when an open root covers it (a scoped
    dir `~/dev` covers `~/dev/x/.ssh/`) — `ScopedFs` refuses it for every
    operation (Filesystem errors above).
  - **Create** (`POST`) is `ScopedFs::create_file` — the `diskfile_create`
    path, taking bytes: exclusive, parents created, 201 `{"size"}`.
  - **Append** (`PATCH`, `ScopedFs::append_file`) writes only when the file
    is exactly `offset` bytes long, checking and writing under one lock, then
    fsyncs: 200 `{"size"}`. Otherwise 409 `{"error": "offset_mismatch",
    "size"}` with nothing written, so a retried chunk is harmless (the size
    says whether it landed) and chunks can't interleave. It never creates the
    file, and a write that fails midway truncates back to `offset`. Unlike a
    save, an append writes the file in place — the filer sees it grow.
  - **Errors** are flat `{"error": <reason>}` bodies with the reason and HTTP
    status `scoped_fs_error` gives the same failure on the file actions
    (`path_not_allowed` 403, `path_not_found` 404, `already_exists` 409, …);
    the message naming the path is logged, not sent.
- **Local tools** (`tool.rs`): the daemon runs `ffmpeg` and whisper.cpp's
  `whisper-cli` as subprocesses. A tool is a large native parser handed
  files from anywhere, so finding and running it are both narrow.
  - **Finding**: `Tools::from_env` runs once at boot (`parse_config`). An
    override (`ZZZ_FFMPEG_BIN`) must be an absolute path to an executable
    file — a bad one refuses to boot, never falls back to a search. Otherwise
    the first `ffmpeg` on `$PATH`'s absolute entries; relative entries are
    skipped, so a tool is never run from the working directory (the rule the
    CLI uses to find `zzzd`). A tool that's simply absent isn't a boot
    failure: what needs it fails when used, `service_unavailable` /
    `tool_unavailable`. `whisper-cli` is found the same way
    (`ZZZ_WHISPER_CPP_BIN`). A **model file** is never searched for:
    `ZZZ_WHISPER_CPP_MODEL` must be an absolute path to a file
    (`resolve_model_file`), or there is none — the same native code parses
    it, and zzz downloads no models.
  - **Running**: `run_tool` takes an argument array (no shell), gives the
    child the handles the caller opened as stdin / stdout (or nothing), the
    environment terminals get (`pty_manager::terminal_env` — no `SECRET_*`,
    `FUZ_*`, `ZZZ_*`, `DATABASE_URL`), and `/` as its directory. A timeout
    kills it, as does dropping the call (a cancelled request), and only the
    last 16 KiB of its stderr is kept. `run_tool_lines` is the same run
    with stdout piped too, handing each output line (cut at 64 KiB) to a
    callback as it's written — for a tool that reports as it goes.
  - **Errors** (`handlers::media::tool_error`): missing →
    `service_unavailable` (-32007; `tool_unavailable`); a non-zero exit →
    `invalid_params` (`media_invalid`, with up to 2000 characters of the
    tool's stderr as `data.stderr` — text derived from the file, so clients
    render it as text); a timeout → `timeout` (-32008; `tool_timed_out`);
    failing to start it → `internal_error`.
- **`ffmpeg` never gets a path** (`media.rs`): a file that looks like audio
  can be a playlist or a concat script telling `ffmpeg` to open other files
  or fetch URLs. Every run reads its input from, and writes its output to,
  handles zzz opened — `-fd 0 -i fd:` and `-fd 1 fd:` — with
  `-protocol_whitelist fd`, so nothing in the file can make it open anything
  else, and the input's format is named (`-f`, from the extension via
  `MediaContainer`) so the bytes are never probed. The input handle is the
  one `ScopedFs::open_file` validated — no second path lookup to race — and
  an `fd:` output on a regular file is seekable, which a muxer needs to go
  back and write the duration.
- **`media_finalize`**: a browser's `MediaRecorder` streams its file out, so
  the header has no duration or seek index. The handler remuxes the file
  (streams copied, nothing re-encoded; five-minute timeout) into an unnamed
  scratch file — created under a `.zzz-tmp-` name in `{zzz_dir}/cache/` and
  unlinked at once, so nothing can be orphaned — then replaces the original
  through `ScopedFs::write_file_from`, the atomic-save path (mode kept, new
  inode). Containers by extension (`MediaContainer::from_path`): `.webm` /
  `.weba`, `.mkv` / `.mka`, `.ogg` / `.oga` / `.opus`, `.mp4` / `.m4a`,
  `.mp3`, `.wav`, `.flac`, `.aac`; anything else is `invalid_params` /
  `unsupported_media_type`, before the file is opened. The same set gates
  `transcription_create`. If
  the file's size changed while `ffmpeg` ran (a recording still being
  appended to), nothing is replaced: `conflict` /
  `changed_during_finalize`. It holds its pooled DB connection for the run,
  like every handler.
- **Jobs** (`job_manager.rs`): work that takes minutes can't be tied to one
  request, tab, or socket. A job is submitted as a closure that builds its
  future from a `JobHandle` (which reports progress and the command lines
  run); `JobManager` — in memory, on `App` beside `PtyManager` — runs them
  **one at a time** in submission order (a drain task spawned on demand;
  the rest wait as `queued`).
  - **Shape**: `JobSnapshot` — `job_id`, `kind` (`transcription`), `status`
    (`queued` / `running` / `succeeded` / `failed` / `cancelled`),
    `progress` (0 to 1, or `null`), `input_path`, `output_path` (once it
    succeeded), `commands` (display strings, in order), `queued_at` /
    `started_at` / `ended_at` (milliseconds), `error`, and `stderr` (the
    failing tool's tail). It's the `job_changed` payload — sent whole on
    every change, to the owning account's sockets only — and what
    `session_load` lists for the caller (`jobs`, oldest first), so a reload
    resyncs.
  - **Ownership**: a job belongs to the account whose request created it.
    Another account's job id behaves exactly like an unknown one
    (`not_found` / `job_not_found`), and a deleted or purged account's
    unfinished jobs are cancelled (the same audit listener that closes its
    terminals, `handlers::terminal::register_account_removal_listener`).
  - **Cancel** (`job_cancel`, the one generic verb — a kind has only its
    own create): a queued job is marked `cancelled` and never starts; the
    running one's future is dropped, and since tools run with
    `kill_on_drop`, its process dies with it; a finished job is left alone.
  - **Lifetime**: finished jobs are kept as history up to
    `MAX_FINISHED_JOBS`, oldest dropped first. Everything is lost on
    restart; `cancel_all` stops and forgets every job at shutdown and in
    `_testing_reset`.
  - A job is not a terminal: it runs on pipes, not a PTY, and ends in a
    typed result. A completion is not a job either — it's request-scoped,
    its progress rides one connection, and the transport's `cancel` ends it.
- **Transcription** (`transcription/`): `transcription_create {path,
  language?}` queues a job and returns `{job_id}`. Everything that can be
  refused up front is, before a job exists: a non-audio extension
  (`unsupported_media_type`), a `language` that isn't `auto` or a short
  code (`invalid_language`), missing tools (`tool_unavailable`), the file
  itself (the `scoped_fs_error` reasons), and this model's transcript
  already being there (`conflict` / `already_exists`).
  - **The work** (`run_transcription`): open the source through
    `ScopedFs` and hash it; decode it with `ffmpeg` to 16 kHz mono PCM
    (`media::decode_speech`, the same handle-only confinement as a remux)
    into an unnamed scratch file; run the backend over that PCM; write the
    sidecar.
  - **The backend** is an enum-dispatched seam (`TranscriptionBackend`,
    like `Provider`) with one variant, whisper.cpp. Its contract is timed
    segments, with timing optional per segment. One `whisper-cli`
    transcription run per job (after a `--version` probe, which isn't among
    the job's recorded commands) — no server, no port, so the audio can't leave the machine by
    construction; the model loads every time. It reads the PCM from
    **stdin** (`-f -`), prints each segment to stdout as it's decoded
    (parsed and sent as `transcription_progress` — a preview) and progress
    to stderr (`-pp` → the job's `progress`), and writes the full result,
    with per-token timings, to a JSON file (`-ojf -of`) in a private
    `.zzz-tmp-<uuid>/` directory under `{zzz_dir}/cache/`, removed
    afterward. So whisper.cpp is given two paths, neither the caller's: the
    configured model and that scratch file. `ffmpeg` is given none.
  - **Words**: whisper.cpp reports tokens. A token starting with a space
    starts a word, any other continues it; a word takes its tokens' span
    and their lowest probability. The JSON isn't always valid UTF-8 (a
    token can be half a character), so it's read lossily and a segment with
    such a token keeps its text but gets no words.
  - **The sidecar** (`Transcript`): `<source path>.<model
    slug>.transcript.json`, created exclusively (`ScopedFs::create_file`),
    so it is written once and never replaced — the slug (`ggml-base.en.bin`
    → `base.en`) keeps one per model. It holds `version`, `source` (`name`,
    `blake3`, `size`, `duration_ms`), `tool` (`backend`, `version`,
    `model`, `model_blake3`, `params`), `language`, and `segments`
    (`start_ms`, `end_ms`, `text`, `words`). The model's hash is cached per
    file version, since a model is gigabytes. It's a text file like any
    other: the filer lists it, and clients read it with `diskfile_read`.
  - **Nothing runs automatically**: no probe, decode, or transcription
    happens because a file appeared. Each is a caller's explicit action.
- **Dispatch is async**: filesystem handlers (`diskfile_update`, etc.) use
  `tokio::fs` async I/O (the atomic write's blocking I/O, and
  `diskfile_read`'s open and read, run on `spawn_blocking`). `project_open`
  resolves its project on `spawn_blocking` (stats, a registry read, at most
  a few git calls through the `App::git` runner, built over an allowlisted
  environment — `PATH`, `HOME`, `XDG_CONFIG_HOME` and nothing
  else, so no inherited `GIT_*` steers it (`git.rs`) — and
  version-checked once at boot, the outcome kept as `App::git_usability`
  for callers with a fallback without git), and it, `project_close`,
  `repo_focus`, and `repo_unfocus` serialize on the `ProjectManager`'s lock
  (a `tokio::sync::Mutex` around the open projects, so holding it is the
  only way to change them), since each spans that state, `ScopedFs`, and
  the filers across await points. Each computes the next state and commits
  it in one place (`ProjectManager::commit`), which derives the filers to
  ensure, stop, or narrow and the roots to set from the two states — no
  operation does that bookkeeping itself — then publishes the snapshot
  `project_list` and `session_load` read without the lock. Each runs in its
  own task — the spine cancels a socket's
  in-flight handlers when it closes, and a dropped caller can't abandon one
  halfway. `project_open` starts the filers — the initial walks and
  watches — before taking the lock, then re-ensures them under the lock (a
  dedup hit, unless a racing close stopped one), so a large tree's scan
  doesn't hold up other opens and closes. The filers the fresh project
  keeps itself are required — one that fails, before the lock or in the
  commit, fails the open with everything it started released — while each
  focus the open requested is scanned and then, under the lock, ensured
  again one by one before the commit (`ProjectManager::open`), so a
  requested focus that can't be listed, or was stopped and removed since
  its scan, is dropped from the next state and refused alone, and the
  commit finds every filer it needs running; what its scan widened is
  released by the commit like anything else the operation started; `repo_focus` does the same with
  its repo's filer, checking the entry before the scan and again under the
  lock. A filer is stopped only when no
  open project keeps it; one an open project no longer needs whole — a
  root that turned into a registry's, indexed at its top level — is
  replaced by a top-level one (`FilerManager::narrow_filer`, the old one
  running until the new one has scanned), once the next state is in effect
  and nothing can fail it; a start never narrows a filer. A close, an
  unfocus, and an operation that fails after its scan release filers the
  same way — the one release, comparing what was kept or started with what
  the open projects keep. Every `project_changed` is broadcast by the
  commit, under the lock, so one root's notifications go out in the order
  its opens, focuses, and closes took effect. Debug builds check after each
  commit that every kept directory has a filer deep enough and that the
  runtime `ScopedFs` roots are the open projects' roots.
- **The lifecycle rev**: a commit that changes the state bumps the
  `ProjectManager`'s rev, under the lock, and stamps it on each project it
  changed (`OpenProject::rev`, kept out of the state's equality, so a
  commit that changes nothing stamps nothing) and on the closed project of
  a close; the published snapshot carries the rev it was taken at
  (`PublishedProjects::rev`, `session_load`'s `projects_rev`). So every
  reply and notification says which state it is, and clients apply only
  newer state (./architecture.md § Projects → The lifecycle rev) instead of
  depending on the order frames arrive in, which a socket's order fixes
  but HTTP doesn't. The counter is seeded at boot from the clock in
  microseconds since the epoch (`rev_seed`), so revs keep increasing across
  a restart (a client still resets what it holds on a new
  `server_instance_id`, so a clock that stepped back costs a resync, not
  wrong state); that stays below 2^53, exact as a JSON number. An open's
  and a focus's reply read their files under the lock their commit held,
  not after it: a commit after the lock dropped could stop or narrow a
  filer the reply reads, and the reply would carry files no state at its
  rev held — which a client applying the reply's state by its rev, since
  no newer state has reached it, would take as the truth (an empty listing
  pruning a repo's files). Reading under the lock costs a clone of the
  reply's indexes while other changes wait, as `repo_files` already does.
- **Ignored paths in the commit**: each commit reads every focused dir's
  ignored set from its filer under the lock (./architecture.md § Projects
  → Ignored paths on the wire), so a set that moved stamps a rev like any
  change and a reply carries the set its rev names; the reply's project is
  read back from the committed state, not the caller's copy.
- **`parking_lot::RwLock`** for short synchronous sections (the published
  projects snapshot, `ScopedFs` roots); no poisoning. The async managers (filer index,
  PTY terminals, providers) use `tokio::sync::RwLock` — scope sync guards
  before await points.
- **PTY terminals**: `fuz_pty` as a native crate dependency (no FFI
  indirection). `PtyManager` in `App` runs one task per terminal that
  exclusively owns the PTY master (`tokio::io::unix::AsyncFd` over a
  `PtyHandle` newtype — `AsRawFd` is a safe impl, so no `unsafe` here) and the
  child pid:
  - **Output** is readiness-driven (no polling) and decoded with
    `utf8_stream::Utf8StreamDecoder` so a multibyte character split across
    reads isn't mangled. `AsyncFd` readiness doesn't spend tokio's coop
    budget, so the loop calls `tokio::task::coop::consume_budget()` per chunk
    — a child that never stops writing (`yes`) can't pin a worker thread.
  - **Output pacing**: every `terminal_data` carries `sent_bytes`, the
    terminal's running total of output bytes (its `data` payloads as UTF-8),
    and `terminal_ack {terminal_id, bytes}` echoes back the `sent_bytes` of
    the last chunk a client finished with. `pty_manager::OutputWindow` holds
    the terminal's total and each consumer's highest ack; once the
    unacknowledged bytes pass `OUTPUT_WINDOW_HIGH_BYTES` (1 MiB) the task
    stops polling the master for reads — the kernel's PTY buffer fills and the
    child blocks in its write — and it reads again at
    `OUTPUT_WINDOW_LOW_BYTES` (256 KiB) or under. Close, input, and resize are
    served while it's paused; EOF isn't seen until the window reopens and the
    rest is read, so a child that exits while paused gets its
    `terminal_exited` then.
    - A **consumer** is a WebSocket connection that has acked the terminal at
      least once and is still registered. Unacknowledged is measured against
      the **highest** ack among them, so a consumer that falls behind doesn't
      stall the others (it stays bounded by its own outbound queue). With no
      consumer — nobody connected, or only clients that never ack — the
      terminal is never paused, and a paused terminal re-checks its
      consumers' connections every `PAUSED_RECHECK_INTERVAL` (kept to a
      second at most by a `const` assertion), so one that closes stops counting
      within that long.
    - Acks are cumulative: a consumer's count only moves up, and one past
      `sent_bytes` counts as all of it. A terminal id names one process, so
      a restarted terminal starts a new count under a new id.
    - `terminal_ack` over HTTP is checked and otherwise ignored — there is no
      connection to pace against.
    - There is no stall timeout. A terminal's only consumer — or its fastest
      one — that stays connected and stops acking (a tab whose JavaScript is
      frozen) holds the terminal paused until its socket closes; a slower
      consumer that stops doesn't, since the terminal follows the highest ack.
  - **Input**: `terminal_data_send` enqueues onto a bounded per-terminal queue
    (at most 256 chunks and 4 MiB held — queued or being written; past
    either → `queue_overflow`, nothing enqueued) and returns. A single chunk
    over 4 MiB is accepted only while nothing is held, so any send the
    16 MiB message cap admits still goes through, and a terminal holds at
    most one such chunk. The task writes each
    chunk in full — looping on partial writes, waiting for writability on
    `EAGAIN` — before the next, so a large paste is never truncated and two
    chunks never interleave. Chunks are written in the order sends reach the
    handler: sends on one socket are dispatched concurrently (each through
    the pool and a `side_effects` transaction), so ordering across sends is
    the client's job.
  - **Resize** is latest-wins through a `watch` channel; `cols` / `rows`
    must be `1..=65535` (`invalid_params` otherwise, never truncated).
  - **Exit**: on EOF the task closes the master, reaps the child, and
    sends `terminal_exited` with the real exit code. `terminal_close`
    sends the signal (`SIGTERM` by default, or `SIGKILL`; any other is
    `invalid_params`, never silently a `SIGTERM`), waits 50ms, closes the master (the hangup ends an
    interactive shell that ignores `SIGTERM`), waits 100ms more, and replies
    with the exit code or `null`; a child still alive is reaped in the
    background (`SIGKILL` after 3s) — no zombie outlives its terminal, and no
    `terminal_exited` is sent for a closed terminal. `kill_all`
    (shutdown, `_testing_reset`) escalates to `SIGKILL` right after the close
    grace and waits for every reap, bounded at 5s.
  - **Ownership**: `terminal_create` records the calling account as the
    terminal's owner. `terminal_data` / `terminal_exited` go to that
    account's sockets only (`ConnectionRegistry::send_to_account`), and
    `terminal_data_send` / `terminal_resize` / `terminal_ack` /
    `terminal_close` from any other
    account behave exactly as for an unknown id (no effect, same reply — see
    below), so a terminal's existence isn't observable across accounts.
    `session_load` lists only the caller's terminal ids. A successful
    `account_delete` / `account_purge` audit event closes the target account's
    terminals (`handlers::terminal::register_account_removal_listener`,
    beside the spine's revocation guard). Creation itself is open
    to any authenticated account (`CredentialGate::Any`) — and a terminal is a
    shell as the daemon's OS user; see ./architecture.md § Security posture.
    Notifications go to every socket of the account, regardless of which API
    token or session opened it.
  - **Spawn** runs in its own task (so a caller dropped mid-spawn can't
    abandon a live PTY) around `spawn_blocking`. A `cwd` must be absolute
    (`invalid_params` / `invalid_path` otherwise — a relative one would
    resolve against zzzd's own working directory). A bad `cwd` or unexecutable command
    fails `terminal_create` (fuz_pty reports the child's `chdir` / `execvpe`
    errno over a close-on-exec pipe). The PTY pair is created close-on-exec
    atomically, so no other child inherits a terminal's master or slave, and
    the child starts with default signal dispositions and an empty mask
    (the Rust runtime's ignored `SIGPIPE` doesn't leak into shells).
  - **Environment**: children get zzzd's environment minus `SECRET_*`,
    `FUZ_*`, `ZZZ_*`, `PUBLIC_ZZZ_*`, `DATABASE_URL`, and `PORT`
    (`pty_manager::terminal_env`, a pure filter). Everything else — `PATH`,
    `HOME`, `SSH_AUTH_SOCK`, `WAYLAND_DISPLAY`, `XDG_*` — passes through,
    since a terminal is the user's shell; fuz_pty forces
    `TERM=xterm-256color`. This keeps secrets out of the child's
    environment; it is not isolation — the shell runs as the same user and
    can still read `/proc/<zzzd pid>/environ` or the `.env` files. The
    prefix match also drops the user's own `FUZ_*` variables (e.g. for the
    `fuz` CLI) from terminals.
  - **Missing terminal IDs** (unknown, ended, lost to a restart, or another
    account's — one `pty_manager::TerminalNotFound`): `terminal_data_send`,
    `terminal_resize`, `terminal_ack`, and `terminal_close` fail with `not_found`
    (`"terminal not found"`, no `data`), so a client notices a terminal it
    thinks is running is gone; the frontend takes a `not_found` close as
    closed, since the process is already gone.
- **Provider system**: Enum-dispatched (`Provider` enum, not trait objects) —
  the providers known at compile time, exhaustive matching. API keys come from
  the `SECRET_*_API_KEY` env vars at construction and are never mutated at
  runtime; provider state sits behind `tokio::sync::RwLock` for the
  `load_status` cache write. The shared client has a 30s connect timeout and
  a 15-minute read timeout (`provider::common::READ_TIMEOUT`): until the
  response headers arrive it's one non-resetting deadline over connect +
  upload + the wait for headers, then it bounds each body read, resetting
  after every one. So a provider that stalls mid-stream or never answers
  can't hold a completion and its pooled DB connection forever; it's
  generous because a non-streaming completion sends no headers until it's
  done (Anthropic caps those at 10 minutes) and reasoning models can go
  quiet mid-stream. It is `https_only` and follows no redirects
  (`reqwest::redirect::Policy::none()`): each request carries the API key in
  its headers, so a plain `http` URL fails before connecting and a `3xx`
  comes back as the response, an upstream error with its status
  (`provider::common::client_builder`; its tests run their plaintext local
  servers through a test-only `https_only(false)`). `complete()` clones the `reqwest::Client`
  (internally `Arc`'d) and releases the lock before HTTP calls, so a
  long-running streaming response doesn't hold it against a status refresh.
  SSE parsing is manual (`provider/sse.rs`: line endings normalized, split
  UTF-8 reassembled, the final event flushed at end of stream).
- **Dispatcher transaction wrap**: `fuz_actions::perform_action` wraps
  `side_effects: true` actions in a `tokio_postgres` transaction (commit on
  `Ok`, rollback on `Err`) and drains post-commit pending effects, so paired
  writes commit atomically; read-only actions get a pooled client with no
  transaction. Either way the handler holds a pooled connection for its whole
  run — a long streaming `completion_create` included.
  zzz's `handlers` functions receive the `ActionContext` DB handle and
  stay transaction-agnostic — the wrap is the spine's concern.
