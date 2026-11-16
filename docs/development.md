# Development

Development workflow, extension points, and common patterns.

## Setup

Requires Node (>=24.14), the Rust toolchain pinned in `rust-toolchain.toml`
(rustup installs it automatically), PostgreSQL, and the sibling [fuz](https://github.com/fuzdev/fuz) and
[fuz_repos](https://github.com/fuzdev/fuz_repos) Rust workspaces checked out
alongside this repo as `fuz/` and `fuz_repos/` (path deps — including
`fuz_pty`, and `fuz_repos` and `fuz_git` for repo registries).
Terminals also need [Zig](https://ziglang.org/download/) 0.17, which builds
the terminal emulator's module (see [Terminal emulator
module](#terminal-emulator-module)); without it everything else runs.

```bash
git clone https://github.com/fuzdev/fuz.git
git clone https://github.com/fuzdev/zzz.git && cd zzz
createdb zzz          # PostgreSQL database the backend connects to
cargo xtask dev-setup   # generate .env.development (idempotent)
npm install           # Node dependencies
cargo xtask dev         # build the terminal module if needed and the Rust backend, then run it with the Vite frontend
```

`cargo xtask dev` first runs the `cargo xtask ghostty-vt` step — a no-op when
the module is current, a build when it's missing or stale (a couple of
minutes the first time). When it can't (no Zig, no network, a failed build)
it warns and carries on: the app runs, and terminals use the module already
installed or, with none, show a message saying how to build it. It then
rebuilds `zzz_server` (`cargo build -p zzz_server`) on every run,
binds the backend on `4461`, and serves the Vite frontend on `5460` (proxying
`/api` → `4461`; the WebSocket connects to `4461` directly). Browse to
`http://localhost:5460` — by that name; see Browser access below.

Optionally add API keys to `.env.development` for remote providers (Anthropic,
OpenAI, Google). Keys are read from the environment only — restart the dev
server after changing one; `/capabilities` shows each provider's status.

### Browser access

`zzzd` answers a browser page only when the page's origin is in
`FUZ_ALLOWED_ORIGINS`, and it trusts whatever page is served there: it can't
tell which process holds a port, and the browser attaches the session cookie
to a request from any `localhost` port.

- **The dev origin is `http://localhost:5460`**, the one entry in
  `.env.development.example`. `vite.config.ts` pins the port with
  `strictPort`, so a second `vite dev` fails on the taken port instead of
  moving to one `zzzd` refuses. The port is zzz's own, not Vite's default
  (`5173`), which is the port another project's dev server holds whenever
  zzz's doesn't. That makes the origin zzz's in practice, not by
  construction: any local process can bind `5460` while zzz's dev server is
  down.
- **Open it as `localhost`.** Vite binds the address `localhost` resolves to,
  often `[::1]` alone, so `http://127.0.0.1:5460` may be another process's
  page and isn't listed.
- **`vite preview`** (`npm run preview`) is pinned to `5461` and isn't
  allowed by default; add `http://localhost:5461` to use it.
- **Another origin** — a different port, a LAN address, a hostname — goes in
  `FUZ_ALLOWED_ORIGINS`, comma-separated, each an exact `scheme://host[:port]`.
  `zzzd` refuses to boot on a malformed entry — a trailing slash, a missing
  scheme, a stray comma — naming it. A port wildcard (`http://localhost:*`)
  lets every page served on any local port act with your session, and a host
  wildcard (`https://*.example.com`) every page on a matching host, so `zzzd`
  refuses to boot on one unless `FUZ_ALLOW_ORIGIN_WILDCARDS=true` is set — the
  refusal says what each admits, and with the flag it logs that as a warning
  on every boot. A plain `http`
  origin that isn't loopback passes the gates but can't log in: the session
  cookie is `Secure`, which a browser accepts only over `https` or on
  loopback.

`.env.development` is created once and never rewritten, so a file written
for another dev port keeps two lines that name it. Set both to the template's
values:

```bash
PUBLIC_ZZZ_SERVER_PORT=5460
FUZ_ALLOWED_ORIGINS=http://localhost:5460
```

- **`PUBLIC_ZZZ_SERVER_PORT`** is the port the UI sends its RPC calls and
  file bytes to — the Vite server it was loaded from. `cargo xtask dev` sets
  it for the Vite it starts, along with `PUBLIC_ZZZ_SERVER_PROXIED_PORT` and
  `PUBLIC_ZZZ_WEBSOCKET_URL`, whatever the file says. A Vite started without
  xtask (`vite dev`, `gro dev`) reads the file, and refuses to start when the
  value isn't the port it serves on, naming the line.
- **`FUZ_ALLOWED_ORIGINS`** must admit `http://localhost:5460`, or `zzzd`
  refuses the UI's login, RPC calls, and WebSocket (403 `forbidden_origin`).
  Replace the line rather than adding to it: a loopback origin on a default
  Vite port left in the list is a port another project's dev server takes,
  and `zzzd` would trust its page.

`cargo xtask dev` prints a warning for each, with the line to set.

In production `zzzd` serves the UI itself, so the allowed origins are its
own — see Production build.

### PTY terminals

Terminal integration uses the `fuz_pty` Rust crate, a native dependency of
the `zzz_server` backend (no FFI indirection). Building the backend
(`cargo build -p zzz_server`) pulls it in. `fuz_pty` lives in a sibling
Rust workspace, which must be checked out alongside this repo. It is
Linux-only (kernel 4.13 or newer), so the backend builds on Linux only.

### Local tools

Recording and transcription use two programs the daemon runs as subprocesses.
Neither is bundled, and zzz builds and runs without them — each feature says
what's missing when it's used. `zzzd` looks for them once, at boot, so
restart it after installing one or changing a variable.

**`ffmpeg`** — for finalizing a recording (so it has a duration and seeks) and
for decoding audio before it's transcribed. Any build with the `fd` protocol
works (`ffmpeg -protocols` lists `fd`; current builds have it), and it
needs the muxers and decoders for what you record — Opus in WebM, for a
browser. A distribution's package is fine:

```bash
sudo apt install ffmpeg   # Debian / Ubuntu
```

`zzzd` uses the `ffmpeg` on its `PATH`; set `ZZZ_FFMPEG_BIN` (an absolute
path) to use another.

**whisper.cpp and a model** — for transcription, which runs entirely on your
machine. Build [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s
`whisper-cli` and download a Whisper model in its `ggml` format; zzz
downloads neither.

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF   # add -DGGML_VULKAN=1 or -DGGML_CUDA=1 for a GPU
cmake --build build --target whisper-cli
./models/download-ggml-model.sh base.en    # → models/ggml-base.en.bin
```

Then point the daemon at them — in `.env.development` for `cargo xtask dev`,
or `~/.zzz/.env` for the `zzz` CLI's daemon. Both must be absolute paths
(`zzzd` refuses to boot on a relative one; in `~/.zzz/.env`, `~/…` works):

```bash
ZZZ_WHISPER_CPP_BIN=/path/to/whisper.cpp/build/bin/whisper-cli   # or put whisper-cli on PATH
ZZZ_WHISPER_CPP_MODEL=/path/to/whisper.cpp/models/ggml-base.en.bin
```

There is no default model and no search for one: transcription is off until
`ZZZ_WHISPER_CPP_MODEL` names a file. The model's name (the file name without
`ggml-` and `.bin`) becomes part of each transcript's file name, so a
recording can hold one transcript per model. Larger models are slower and
more accurate; the `.en` ones are English-only.

The Vulkan build needs the Vulkan headers, a GLSL compiler, and the SPIR-V
headers (`libvulkan-dev`, `glslc`, and `spirv-headers` on Debian).

There is no switch that turns media off: transcription is off while
`ZZZ_WHISPER_CPP_MODEL` is unset, and recording, the byte routes, and
finalize are always there. An `ffmpeg` without the `fd` protocol fails
every run as `media_invalid`.

### Terminal emulator module

The `fuz_terminal` library (`src/lib/fuz_terminal/`) binds
[libghostty-vt](https://lib.ghostty.org/vt/), Ghostty's terminal emulator,
compiled to WebAssembly, and draws zzz's terminals with it. The module is
fetched from the app's static assets when a terminal first mounts, so the
app runs without it — everything but the terminal views, which show a
message saying how to build it (their processes still run, and their output
buffers). Building it needs [Zig](https://ziglang.org/download/)
0.17 (any 0.17.x release — libghostty-vt 1.0 builds with no other minor),
plus `curl`, `tar`, and `sha256sum`:

```bash
cargo xtask ghostty-vt   # → static/fuz_terminal/ghostty-vt.wasm (gitignored)
```

It downloads the pinned release's source and dependency tarballs into
`target/ghostty-vt/`, refuses either unless its sha256 matches the pin,
then builds offline from them (a couple of minutes cold). A later run
reuses the verified tarballs, and when the installed module is current for
the pinned version, feature set, and Zig, it's a no-op. `cargo clean`
removes the cache, not the module. `cargo xtask dev` runs this step before it
starts (warning instead of failing when it can't). The tests that load the
module are `src/test/fuz_terminal/**/*.wasm.test.ts` and
`src/test/TerminalView.wasm.test.ts`, run by the `fuz_terminal_wasm` vitest
project, which exists only when the module does.

## Commands

- `gro check` — All checks (typecheck, test, gen, format, lint)
- `gro typecheck` — Type checking only (faster iteration)
- `gro test` (or `npm test`) — Run Vitest unit + db tests; the
  `cross_backend_*` projects are excluded unless `FUZ_TEST_CROSS_BACKEND=1`
  (`npm run test:cross` sets it — ../crates/CLAUDE.md § Integration Tests)
- `gro test -- --watch` — Tests in watch mode
- `gro gen` — Run `*.gen.ts` generators (regenerate their outputs)
- `gro format` — Format with tsv
- `gro lint` — ESLint checking
- `gro build` — Production build
- `gro deploy` — Deploy to production

`cargo xtask dev` runs the dev server (the terminal module when it's missing
or stale, then the Rust backend + Vite frontend) — the user manages it; don't
start it yourself.

Three task runners, by role: **`gro`** for checks, build, gen, and tests
(`gro check` / `build` / `gen` / `test`); **`cargo xtask`** for the dev server and
env setup (`dev`, `dev-setup`, `prod-setup`) and the terminal emulator's wasm
module (`ghostty-vt`); **`npm run`** for the package
scripts, notably `test:cross` (the Rust cross-process suites). `npm run dev`,
`npm run dev:setup`, and `npm run prod:setup` alias the matching `cargo xtask`
commands.

## Production build

There are two production targets:

- **Static-only** — `gro build` prerenders the SPA into `build/`, and `gro deploy`
  publishes it to a static host. adapter-static prerenders the
  fixed routes (`chats.html`, `docs/api.html`, …) and writes `200.html`, an SPA
  shell for everything else (dynamic routes like `/chats/<id>` are never
  prerendered). No Rust backend, so the
  filesystem, terminals, AI, and auth are unavailable — the "diminished
  capabilities" build.
- **Full self-hosted** — the same `build/` SPA served by the Rust `zzz_server`
  daemon, which also serves `/api`. This is the complete app, and needs **both**
  a frontend build and a backend build (`gro build` only does the SPA).

The terminal emulator's module ships in `build/` only when it was built:
`gro build` copies `static/`, and `static/fuz_terminal/ghostty-vt.wasm` is
gitignored output of `cargo xtask ghostty-vt`. So whoever builds a release
needs Zig 0.17 and runs that step first; a build without it works, and its
terminals say the module is missing. `gro build`'s cache is keyed on the
commit, and the module is gitignored, so building it doesn't invalidate a
cached build: run `gro build --force_build` after building the module.
`zzzd` serves it as `application/wasm` (so the browser compiles it as it
downloads), and a missing one is a 404, never the SPA shell.

Build and run the full self-hosted server:

```bash
cargo xtask prod-setup                      # writes .env.production (fresh cookie key) — edit its other secrets
cargo xtask ghostty-vt                      # the terminal emulator module → static/ (needs Zig 0.17)
gro build                                 # frontend → build/
cargo build -p zzz_server --release       # backend  → target/release/zzzd
./target/release/zzzd --static-dir build  # serve SPA + /api (port 4460; --port/ZZZ_PORT overrides)
```

`zzzd` reads its config from the **process environment** — it does _not_ load
`.env.production` itself (unlike `cargo xtask dev`, which loads `.env.development`
and injects it into the child processes — the file winning over any exported
value, with a line per overridden key — and the `zzz` CLI, which supplies
`~/.zzz/.env` with the exported values winning — see below). Supply the env via your process manager, a systemd
`EnvironmentFile`, or, in a shell, `set -a && . ./.env.production && set +a` before
running. It requires `DATABASE_URL`, `SECRET_FUZ_COOKIE_KEYS`, and a non-empty
`FUZ_ALLOWED_ORIGINS` (it hard-fails at boot otherwise) — the template lists
`zzzd`'s own two origins, `http://localhost:4460` and `http://127.0.0.1:4460`,
which are the page it serves; change both with the port. `--static-dir` (or
`ZZZ_STATIC_DIR`) points it at the built frontend; CLI flags win over env. It
serves the exact file, then the prerendered `{path}.html`, then the `200.html`
shell, so reloads, deep links, and dynamic routes load; `/api` and `/health`
paths and missing `_app/` and `fuz_terminal/` assets 404 instead. In
production the SPA and API share one origin, so `.env.production` leaves the
`PUBLIC_ZZZ_SERVER_*` host/port and `PUBLIC_ZZZ_WEBSOCKET_URL` empty: the UI
derives its API and WebSocket URLs from the page's origin, so one build works
on whatever port `zzzd` serves it from. `gro build` reads `.env.production`
— the `PUBLIC_ZZZ_*` vars (declared in `src/env.ts`) are baked in at build
time, and each is optional: unset reads as empty. Leave
`PUBLIC_ZZZ_SERVER_PROTOCOL`, `PUBLIC_ZZZ_SERVER_HOST`,
`PUBLIC_ZZZ_SERVER_PORT`, and `PUBLIC_ZZZ_WEBSOCKET_URL` empty or unset:
a non-empty `PUBLIC_ZZZ_SERVER_PORT` or `PUBLIC_ZZZ_WEBSOCKET_URL` pins the
build to that fixed server instead of the page's origin.

### Through the `zzz` CLI

The `zzz` CLI runs the same daemon from its home, `~/.zzz/`:

```bash
cargo build -p zzz -p zzz_server --release   # put target/release on PATH — zzz finds zzzd beside itself
zzz init                                  # ~/.zzz/: config.json, .env (fresh cookie key), bootstrap_token
cargo xtask prod-setup                    # .env.production, which `gro build` reads (idempotent)
cargo xtask ghostty-vt                    # the terminal emulator module, which `gro build` copies (needs Zig 0.17)
gro build && rm -rf ~/.zzz/static && cp -r build ~/.zzz/static   # the UI the daemon serves
zzz                                       # start the daemon (detached) and open zzz (the browser, or a configured opener)
```

The CLI passes `zzzd` its own environment with `~/.zzz/.env` filling the
gaps, runs it in `~/.zzz` (relative paths in `~/.zzz/.env` resolve there;
relative paths in the CLI's own environment resolve against where `zzz` runs), and
serves the UI from `ZZZ_STATIC_DIR` if set, else `~/.zzz/static` — the full
rules are in § The `zzz` CLI below.

## The `zzz` CLI

The Rust CLI (`crates/zzz`, argh; its modules in ../crates/CLAUDE.md) manages
the daemon and opens the UI:

```bash
zzz                          # start daemon if needed, open zzz (the browser, or a configured opener)
zzz ~/dev/zzz                # open the project holding ~/dev/zzz, focused on its repo (a file works too)
zzz daemon start             # start daemon (foreground)
zzz daemon stop              # stop the recorded daemon
zzz daemon status            # show daemon info (exit 0 running, 1 not responding, 3 not running, 4 unknown)
zzz init                     # initialize ~/.zzz/
```

The global daemon runs on port 4460 with `~/.zzz/` as its home and working
directory. `zzz init` creates it (mode `0700`) with `config.json` (the port),
`.env` (the daemon's environment, mode `0600`, with a generated cookie key),
`bootstrap_token` (the one-shot admin token), and the app directory `.zzz/`
(so `~/.zzz/.zzz/`) — never overwriting an existing file. The daemon deletes
the token once the first admin exists; a later `zzz init` recreates it when
missing (say the database was dropped), and a running daemon picks it up on
restart, since it checks bootstrap availability once at boot. The CLI spawns
and discovers the `zzzd` daemon binary (the `[[bin]]` target of the
`zzz_server` crate) — `ZZZ_SERVER_BIN` (a relative value resolves against
the directory `zzz` runs in; one that isn't an executable file is an error,
not a fallback), else beside the resolved CLI executable (symlinks followed,
so a symlinked `zzz` finds the `zzzd` beside its target; this covers a dev
build: `target/debug/zzz` runs `target/debug/zzzd`), else `~/.zzz/bin/zzzd`,
then `zzzd` on `$PATH` — a candidate that isn't an executable file is skipped.
Never from the current directory (relative `$PATH` entries are skipped), so
running `zzz` inside an untrusted checkout can't execute its
`target/debug/zzzd` with your database URL and cookie key; finding none is an
error (`ZZZ_SERVER_BIN` must `exec` the server, not fork it — the listening socket
is checked on the spawned pid). Build both
with `cargo`: `cargo build -p zzz` (CLI) and `cargo build -p zzz_server`
(daemon → `zzzd`).

When the CLI starts `zzzd` it:

- **env** — passes its own environment, with `~/.zzz/.env` filling any
  variable that environment doesn't set (or sets blank — a blank value is
  never passed on: the CLI removes it from the child's env; so to disable a
  key `~/.zzz/.env` sets, comment it out there — an empty exported value
  doesn't override it), and
  `FUZ_ALLOWED_ORIGINS` defaulting to
  `http://localhost:<port>,http://127.0.0.1:<port>`. `DATABASE_URL` and
  `SECRET_FUZ_COOKIE_KEYS` must be set in one or the other. `.env` lines
  that aren't assignments are skipped with a warning naming their line
  numbers. When the environment overrides a `.env` key with a different
  value, a note names the key (never the value).
  `ZZZ_ENABLE_TEST_ACTIONS` is never passed on, from either source (a
  warning says so when it's set).
- **cwd** — runs it in `~/.zzz`. For the path-valued vars (`PUBLIC_ZZZ_DIR`,
  `PUBLIC_ZZZ_SCOPED_DIRS`, `ZZZ_ROOTS_OUTSIDE_HOME`,
  `FUZ_BOOTSTRAP_TOKEN_PATH`, `ZZZ_STATIC_DIR`,
  `ZZZ_FFMPEG_BIN`, `ZZZ_WHISPER_CPP_BIN`, `ZZZ_WHISPER_CPP_MODEL`) the
  CLI expands `~`; a relative value from `~/.zzz/.env` resolves against
  `~/.zzz`, and one from the CLI's own environment against the directory
  `zzz` runs in. The three tool vars are the exception to the first half:
  `zzzd` requires them absolute, so a relative one in `~/.zzz/.env` (which
  the CLI passes through as written) refuses to boot — write `~/…` or a full
  path there.
- **port** — `--port` (only `zzz daemon start` takes it: `zzz` reuses
  whatever daemon is recorded) > `ZZZ_PORT` > `zzz_config_port` in
  `~/.zzz/config.json` > 4460, passed as `--port`; the port must be free.
  Every source must be a port in `1..=65535`, and a `config.json` that
  exists must parse as a JSON object — otherwise it's an error naming the
  source (the file, for `config.json`), never a fallback.
- **UI** — `ZZZ_STATIC_DIR` if set (must be a directory), else
  `~/.zzz/static`, passed as `--static-dir`; neither is an error.

A daemon counts as started once the spawned process itself holds the
listening socket and answers `/health` (probed on `127.0.0.1`, bypassing any
`HTTP(S)_PROXY`); one that exits first fails the start at once (the detached
`zzz` start shows the tail of `~/.zzz/run/daemon.log`, mode `0600`). Until it
serves, a timeout or SIGINT/SIGTERM/SIGHUP stops the child (`SIGTERM`, then
`SIGKILL` after 10s) — no unrecorded daemon is left behind — and
`daemon.json` is written only once it serves. `~/.zzz/run/daemon.json`
identifies the daemon by boot id, pid, **and** kernel start time, so a pid
reused by another process (or a record from before a reboot) is treated as
gone — never signalled — and the file is removed only while it still
records the same process: by `zzz daemon start` when its foreground daemon
exits, by `stop` (after stopping it, or once it's stale), by `zzz` (once it's
stale, or after stopping an unresponsive one), or by `status` once it's
stale. A `daemon.json` this zzz can't read — an older or newer zzz's, or a
corrupt one — is reported (with its pid, "stop it manually", when it names
one; a corrupt one usually doesn't, so "remove it once no daemon is running")
and never signalled, removed, or overwritten: `zzz` and `zzz daemon start`
refuse to start a daemon while it's there, `zzz daemon stop` refuses to
signal, and `status` reports the state unknown (exit 4). Once serving, foreground
`zzz daemon start` exits with zzzd's own status (0 on a clean stop, 128 + the
signal if one killed it); a signal during startup exits 128 + that signal, and
a startup failure exits 1. A usage or config error — a bad argument, a
non-UTF-8 one, an invalid port, a bad `config.json`, missing env, no `zzzd` —
exits 2 before anything runs; `--help` exits 0.

`zzz <path>` expands `~`, resolves the path against the current directory,
and canonicalizes it before building the `/projects?project=<path>` URL —
a directory with a trailing `/`, a file as itself; a missing path is an
error. The page opens it with `project_open`: the daemon resolves the
project holding it (a file, its parent's) — a trusted `repos.toml` above
it, else its git checkout, else the directory, with a path in none of the
registry's repos opening as its checkout or directory — says where it
rooted and why, and focuses the repo
holding the path (./architecture.md § Projects). The file
itself isn't opened in a tab yet — the page opens its project. The daemon
holds the opened directory and the project's root to its root rules
(§ Environment Variables → `ZZZ_ROOTS_OUTSIDE_HOME`): `zzz ~`, a file directly in `~`,
`/`, an ancestor of `$HOME`, or anything under `/proc`, `/sys`, or `/dev`
is refused (`root_not_allowed`), and any other directory outside `$HOME`
needs that list (`root_outside_home` without it).

`zzz` opens that URL in the browser (`xdg-open` / `open` / `start`) unless an
**opener** — an open command to run instead — is configured:

- **sources** — `opener` in `~/.zzz/config.json`, then `ZZZ_OPENER` in the
  CLI's own environment (`~/.zzz/.env` is the daemon's and isn't read for
  it). A blank value (or a config `null`) reads as unset and falls through to
  the next source, then to the browser.
- **shape** — in `config.json`, a string is the program alone (never split)
  and an array of strings is the program followed by its arguments, so flags
  need no shell parsing: `"opener": ["~/bin/my-opener", "--new-window"]`.
  Any other JSON type, an empty array, a non-string element, or a blank
  program (the array's first element) is an error naming the file.
  `ZZZ_OPENER` is the program alone.
- **program** — surrounding whitespace is trimmed and `~` expands; a relative
  path resolves against `~/.zzz` from `config.json` and against the directory
  `zzz` runs in from `ZZZ_OPENER`. A bare name (no `/` — `~name` included, as
  only `~` and `~/…` expand) is refused from both sources: `$PATH` isn't
  searched, and `zzz` never runs a same-named executable from whatever
  directory it's in — write `./name` for a file in that directory, or an
  absolute path. A bare name, or a program that isn't an executable file, is
  an error (exit 2), checked before any daemon is started — never a fallback
  to the browser, and a bad `config.json` opener doesn't fall back to
  `ZZZ_OPENER`.
- **launch** — the URL is the final argument, after the configured ones, and
  the program is executed directly: no shell sees the URL or the arguments.
  The URL is always its own argument, so a `--flag=<url>` form needs a
  wrapper script. It runs detached (its own process group, output in
  `~/.zzz/run/opener.log`, mode `0600`, emptied at each launch) in the
  directory `zzz` runs in, with the CLI's environment
  minus `ZZZ_ENABLE_TEST_ACTIONS`; the daemon's `~/.zzz/.env` values aren't
  added. `zzz` doesn't wait for it, so the opener's own exit status isn't
  checked; only a failure to start it is an error (exit 1).

`zzz` reads `config.json` for the opener on every run, so a file that isn't a
JSON object is an error (exit 2) even when a daemon is already running.

## Environment Variables

### Server (read by `zzz_server` at boot)

- `ZZZ_PORT` — HTTP server port (default 4460; `cargo xtask dev` uses 4461); the `--port` flag wins. Anything but a port in `1..=65535` refuses to boot. The bind address is always loopback — there is no `HOST` override.
- `ZZZ_STATIC_DIR` — directory of the built SPA to serve (`--static-dir` wins); must be a directory, or `zzzd` refuses to boot. Unset, `zzzd` serves no frontend (dev: Vite serves it)
- `ZZZ_TRUSTED_PROXIES` — comma-separated trusted proxy IPs / CIDR ranges for `client_ip` resolution
- `ZZZ_FFMPEG_BIN` — the `ffmpeg` binary to run (see § Local tools); an absolute path to an executable file, or `zzzd` refuses to boot. Unset, `zzzd` uses the `ffmpeg` on its `PATH`
- `ZZZ_WHISPER_CPP_BIN` — whisper.cpp's `whisper-cli` binary to run, under the same rule. Unset, `zzzd` uses the `whisper-cli` on its `PATH`
- `ZZZ_WHISPER_CPP_MODEL` — the Whisper model file (`ggml-*.bin`) transcription loads; an absolute path to a file, or `zzzd` refuses to boot. There is no default and no search — unset, nothing is transcribed. zzz downloads no models
- `DATABASE_URL` — PostgreSQL connection (`postgres://`; required — unset or blank refuses to boot, naming it)
- `SECRET_FUZ_COOKIE_KEYS` — HMAC signing keys (min 32 chars; required, like `DATABASE_URL`)
- `FUZ_ALLOWED_ORIGINS` — the origins the UI is served from, checked against every browser request's `Origin` (required — `zzzd` refuses to boot on an absent or empty list, since an empty allowlist would allow every origin; the CLI defaults it to `http://localhost:<port>,http://127.0.0.1:<port>`). List exact ports: the session cookie reaches every port on `localhost`, so a wildcard (`http://localhost:*`) admits any page served on any local port to the WebSocket. Each entry is `scheme://host[:port]`, http or https; a malformed one (a trailing slash, a missing scheme, a stray comma, a scheme's default port written out, …) refuses to boot, naming the entry, and a wildcard port or host label refuses to boot, saying what it admits, unless `FUZ_ALLOW_ORIGIN_WILDCARDS=true` (exactly `true` or `false`), which boots it with that warning on every boot. The hosts it names are also the non-loopback `Host`s `zzzd` answers to (see ./architecture.md § Security posture)
- `FUZ_BOOTSTRAP_TOKEN_PATH` — One-shot admin bootstrap token path
- `FUZ_DB_CHECKOUT_TIMEOUT_MS` — bound on the pool checkouts a request makes, in ms (default 5000, `1..=600000`; anything else refuses to boot); a failed checkout answers 503 `service_unavailable`, a failed query keeps its 500. `FUZ_DB_AUDIT_CHECKOUT_TIMEOUT_MS` (default 30000, same range) bounds the checkout behind each audit pool write instead — the failed-login row a request waits on included
- `PUBLIC_ZZZ_DIR` — Zzz app directory (default `.zzz`, a subdirectory of the daemon's working directory); must not be the working directory itself (under the CLI that's the daemon home, with `.env` and `bootstrap_token`) — `zzzd` refuses to boot on that. The check catches the daemon home only as the working directory: an explicit `PUBLIC_ZZZ_DIR` naming the absolute path of `~/.zzz` for a daemon run elsewhere (say `cargo xtask dev`) makes the home the app dir, whose filer indexes and broadcasts its `.env` — don't. It may sit outside `$HOME` without being allowlisted, but `/`, `$HOME` or an ancestor of it, a directory under `/proc`, `/sys`, or `/dev`, or one in a credential directory refuses to boot
- `PUBLIC_ZZZ_SCOPED_DIRS` — Comma-separated filesystem paths (`zzzd` doesn't expand `~`; the CLI does); each must pass the root rules (below `ZZZ_ROOTS_OUTSIDE_HOME`), and an entry that is, or is inside, a credential directory or a `.zzz` directory other than the app dir refuses to boot, naming the variable, the entry, and why. An entry that doesn't exist yet is checked as spelled, and refuses to boot if it has a `..`; it's checked again on its canonical path when its filer starts, and isn't indexed (with a warning) if that's refused or isn't the path the boot checked
- `ZZZ_ROOTS_OUTSIDE_HOME` — Comma-separated directories outside the home directory that roots (project roots, scoped dirs) may be at or inside, read like `PUBLIC_ZZZ_SCOPED_DIRS` (each resolved, blank entries skipped; `zzzd` doesn't expand `~`, the CLI does). Every root must otherwise be strictly inside `$HOME` — the daemon's `HOME` (or, unset, the password database's home), canonicalized at boot — and is never `/`, `$HOME` or an ancestor of it, or under `/proc`, `/sys`, or `/dev`, whatever this names: an entry naming one of those refuses to boot. A `$HOME` that can't be resolved, isn't a directory, or is `/` is no home — `zzzd` logs a warning and admits only what this names. `project_open` of a path whose project root or opened directory the rules refuse is `forbidden` with `root_outside_home` (this would admit it) or `root_not_allowed` (nothing would)
- `ZZZ_ENABLE_TEST_ACTIONS` — Register `_testing_*` actions on live dispatchers (integration tests only — must stay unset in prod; blank reads as unset, and the `zzz` CLI never passes it to a daemon it starts)
- `SECRET_ANTHROPIC_API_KEY` — Claude API key
- `SECRET_OPENAI_API_KEY` — OpenAI API key
- `SECRET_GOOGLE_API_KEY` — Google Gemini API key

`zzzd` reads a blank (empty or whitespace) value of any of its path vars as
unset — `PUBLIC_ZZZ_DIR` falls back to `.zzz`, never `/` — and fails to boot
on an empty or unresolvable path (a missing scoped dir is fine). It creates
the app directory (and missing parents, mode `0700`) at boot, and fails to
boot with the path in the error if it can't. A value that isn't valid UTF-8
fails boot too, rather than reading as unset.

Its command line is `zzzd [--port <port>] [--static-dir <dir>]` (each value
also as `--flag=value`); `-h` / `--help` prints that usage (exit 0), and an
unknown or malformed argument exits 2 with the usage on stderr rather than
being ignored. A `--static-dir` may be any path, UTF-8 or not. A boot failure
prints `error: <error chain>` and a hint to stderr and exits 2 for a
configuration error (env, the database's isolation setting), 1 otherwise.

PTY terminals spawned by the server don't get the `SECRET_*`, `FUZ_*`,
`ZZZ_*`, `PUBLIC_ZZZ_*`, `DATABASE_URL`, or `PORT` variables — they're
scrubbed from the child environment, which keeps them out of a shell's env
but isn't isolation (see ./architecture.md § Known Limitations → PTY terminals).

`zzzd` reads only its process environment — it loads no env file. The `zzz`
CLI supplies it from `~/.zzz/.env`, where the **process env wins** (the file
fills gaps; see § The `zzz` CLI); `cargo xtask dev` from `.env.development`, where the
**file wins** — it's dev's source of truth, so a stale exported
`DATABASE_URL` can't redirect dev migrations, and xtask prints each
inherited key it overrides. In both, a blank value is unset: a template's
empty `SECRET_*_API_KEY=` line never clears an exported key. `.env.production` is what `gro build` reads for
the `PUBLIC_ZZZ_*` vars, and the template for running `zzzd` under a process
manager (see § Production build). The CLI itself also
reads `ZZZ_SERVER_BIN` (the `zzzd` binary to spawn) and `ZZZ_OPENER` (an
open command to run instead of the browser — see § The `zzz` CLI).

### SvelteKit frontend vars (PUBLIC_ZZZ_\*)

Declared in `src/env.ts` (public and static, imported from `$app/env/public`),
so the build bakes them in. Each is optional — unset reads as empty, and
`src/lib/constants.ts` supplies the default.

- `PUBLIC_ZZZ_SERVER_PROTOCOL` — `http` or `https`
- `PUBLIC_ZZZ_SERVER_HOST` — Server hostname (frontend)
- `PUBLIC_ZZZ_SERVER_PORT` — the server the UI calls (dev: the Vite port, 5460, which proxies `/api` — `cargo xtask dev` forces it, and `vite dev` refuses to start when it names any other port than the one it serves on: `src/lib/dev_server_port.ts`); empty → the page's own origin, which is how the production build (served by `zzzd` on any port) is configured
- `PUBLIC_ZZZ_SERVER_API_PATH` — API endpoint path
- `PUBLIC_ZZZ_WEBSOCKET_URL` — WebSocket URL (dev: `zzzd` directly); empty → `<API path>/ws` on the page's origin

`PUBLIC_ZZZ_SERVER_PROXIED_PORT` is dev-only and not baked in: `vite.config.ts`
reads it from the process env as the backend port its dev proxy targets
(`cargo xtask dev` forces 4461).

## Code Generation

The `*.gen.ts` files are hand-written generators; `gro gen` runs them and writes
their outputs. Edit the generators, never the outputs (each output carries a
`DO NOT EDIT` banner):

- `action_collections.gen.ts` (`src/lib/action_collections.ts`) — `ActionInputs` / `ActionOutputs` type maps + `ActionEventDatas`
- `action_metatypes.gen.ts` (`src/lib/action_metatypes.ts`) — the `ActionMethod` open union, the narrow handler enums (`BackendRequestResponseMethod`, `BroadcastActionMethod`, …), the `FrontendActionsApi` interface
- `frontend_action_types.gen.ts` (`src/lib/frontend_action_types.ts`) — `TypedActionEvent` + `FrontendActionHandlers`
- `reference.gen.ts` (`docs/reference.md`) — Action-spec + cell-class reference lists

Run `gro gen` after changing `action_specs.ts` (or `cell_classes.ts`). `gro check`
fails if any output is stale.

## File Naming

- `snake_case.ts` — TypeScript modules. Example: `helpers.ts`, `frontend_action_handlers.ts`
- `snake_case.svelte.ts` — Svelte 5 reactive state. Example: `chat.svelte.ts`
- `PascalCase.svelte` — Svelte components. Example: `ChatView.svelte`
- `snake_case.test.ts` — Test files (in `src/test/`). Example: `cell.svelte.base.test.ts`
- `*_types.ts` — Type definitions. Example: `cell_types.ts`
- `*_helpers.ts` — Utility functions. Example: `diskfile_helpers.ts`

### Component Naming

Components use `PascalCase` with domain prefixes:

- `Chat` — Chat UI. Examples: `ChatView`, `ChatListitem`
- `Diskfile` — File editor. Examples: `DiskfileEditorView`, `DiskfileExplorer`
- `Model` — Model management. Examples: `ModelListitem`, `ModelPickerDialog`
- `Part` — Content parts. Examples: `PartView`, `PartEditorForText`
- `Prompt` — Prompts. Examples: `PromptList`, `PromptListitem`
- `Terminal` — Terminals. Examples: `TerminalRunner`, `TerminalView`, `TerminalContextmenu`
- `Thread` — Threads. Examples: `ThreadList`, `ThreadContextmenu`
- `Turn` — Turns. Examples: `TurnView`, `TurnListitem`

## Extension Points

### Adding a New Cell

1. Define schema (in the `*.svelte.ts` file or a separate `*_types.ts`):

```typescript
export const MyThingJson = cell_json_schema(
	{
		name: with_default(string, ''),
		value: with_default(number, 0)
	},
	'MyThing'
);
```

2. Create the class (`src/lib/my_thing.svelte.ts`):

```typescript
export class MyThing extends Cell<typeof MyThingJson> {
	name: string = $state.raw()!;
	value: number = $state.raw()!;

	readonly doubled = $derived(this.value * 2);

	constructor(options: MyThingOptions) {
		super(MyThingJson, options);
		this.init(); // Must call at end
	}
}
```

3. Register in `src/lib/cell_classes.ts`, under the same name as the schema's
   `cell_class_name` (the registry's key — `constructor.name` is mangled by
   minification):

```typescript
export const cell_classes = {
	// ... existing classes
	MyThing
} satisfies Record<string, typeof Cell<any>>;
```

### Adding a New Action

The test-only `_testing_emit_notifications` and `_testing_notification`
specs live in `src/lib/testing_action_specs.ts`, as TS twins of the methods
`zzzd` registers only when `ZZZ_ENABLE_TEST_ACTIONS=1`.

1. Define the spec in `src/lib/action_specs.ts`:

```typescript
export const my_action_action_spec = {
	method: 'my_action',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'required', actor: 'none' }, // or {account: 'none', actor: 'none'} for public
	side_effects: true, // false for read-only
	input: object({
		message: string
	}),
	output: object({
		result: string
	}),
	async: true,
	description: 'What this action does.'
} satisfies RequestResponseActionSpec;
```

2. Run `gro gen` to regenerate handler types.

3. Add frontend handler (`src/lib/frontend_action_handlers.ts`) — handlers go
   inside `create_frontend_action_handlers(frontend)` and reach app state via the
   closed-over `frontend` (the action event itself carries no `app`):

```typescript
my_action: {
  send_request: ({data: {input}}) => {
    console.log('sending:', input.message);
  },
  receive_response: ({data: {output}}) => {
    console.log('received:', output.result);
  },
  receive_error: ({data: {error}}) => {
    console.error('failed:', error);
  },
},
```

4. Add the backend handler in the Rust backend (`crates/zzz_server`): a spec
   builder in `zzz_action_specs/` and the handler fn in `handlers/`. Both
   HTTP RPC and WebSocket paths dispatch through the same `ActionRegistry`,
   so the handler is picked up on both transports. See ../crates/CLAUDE.md.

### Streaming Handlers

For actions that push progress notifications back to the requester while
running, pair the `request_response` action with a companion
`remote_notification` action and name the companion in the `streams` field:

```typescript
export const my_long_job_action_spec = {
  method: 'my_long_job',
  kind: 'request_response',
  initiator: 'frontend',
  auth: {account: 'required', actor: 'none'},
  side_effects: true,
  streams: 'my_long_job_progress', // name of the companion notification
  input: object({...}),
  output: literal(null),
  async: true,
  description: 'Run a long job, streaming progress.',
} satisfies RequestResponseActionSpec;

export const my_long_job_progress_action_spec = {
  method: 'my_long_job_progress',
  kind: 'remote_notification',
  initiator: 'backend',
  auth: null,
  side_effects: true,
  input: object({...}),
  output: fuz_void, // `void as fuz_void` from `@fuzdev/fuz_schema/schema.ts`
  async: true,
  description: 'Streams a progress chunk for `my_long_job`.',
} satisfies RemoteNotificationActionSpec;
```

The backend handler sends progress chunks to the originating socket
(request-scoped) and terminates early when the socket closes;
`completion_create` + `completion_progress` is the worked example. Broadcasts
to all connected sockets (server-wide events like `filer_change` or
`project_changed`) go through the backend's realtime connection registry.
See ../crates/CLAUDE.md for the Rust handler patterns.

### Adding a New Route

Create `src/routes/my_route/+page.svelte`:

```svelte
<script lang="ts">
	import { frontend_context } from '#lib/frontend.svelte.ts';

	const app = frontend_context.get();
</script>

<h1>My Route</h1>
```

## Common Patterns

### State Access

```svelte
<script lang="ts">
	import { frontend_context } from '#lib/frontend.svelte.ts';

	const app = frontend_context.get();
	const { chats, models, prompts } = app;
</script>
```

### Collection Operations

```typescript
// Add
const chat = app.chats.add({ name: 'New Chat' });

// Get by ID
const chat = app.chats.items.by_id.get(id);

// Get by single index
const model = app.models.items.by_optional('name', 'gpt-5-2025-08-07'); // Model | undefined

// Query multi-index
const claude_models = app.models.items.where('provider_name', 'claude'); // ReadonlyArray<Model>

// Iterate
for (const chat of app.chats.items.values) {
	console.log(chat.name);
}
```

### Action Invocation

```typescript
// Request/response
const result = await app.api.completion_create({
  completion_request: {...},
  _meta: {progressToken: turn.id},
});

// Local action (sync)
app.api.toggle_main_menu();
```

### Component Pattern (Svelte 5)

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';

	const {
		title,
		children
	}: {
		title: string;
		children?: Snippet;
	} = $props();
</script>

<div class="my-component">
	<h2>{title}</h2>
	{#if children}
		{@render children()}
	{/if}
</div>
```

### Context Menus

```svelte
<script lang="ts">
	import Contextmenu from '@fuzdev/fuz_ui/Contextmenu.svelte';
	import ContextmenuEntry from '@fuzdev/fuz_ui/ContextmenuEntry.svelte';
</script>

<Contextmenu>
	{#snippet entries()}
		<ContextmenuEntry onclick={() => doSomething()}>Action Label</ContextmenuEntry>
	{/snippet}
	<div>Right-click me</div>
</Contextmenu>
```

## Testing

Tests live in `src/test/` (not co-located). Split large suites by aspect with dot-separated names.

`src/test/sveltekit_env_setup.ts`, a vitest setup file, stubs the page global
that `$app/env/public` reads.

```bash
gro test                                    # all tests
gro test -- --watch                         # watch mode
gro test -- src/test/cell.svelte.base.test.ts  # specific file
```

The cross-backend suites (`npm run test:cross`, see ../crates/CLAUDE.md) run
against a real daemon, which inherits the environment they're started in. The
media tests there use whatever tools that environment has and skip the rest,
visibly: without `ffmpeg` on `PATH` the finalize tests skip, and without
whisper.cpp plus `ZZZ_WHISPER_CPP_MODEL` the transcription tests do. To run
them all:

```bash
ZZZ_WHISPER_CPP_BIN=/path/to/whisper-cli \
ZZZ_WHISPER_CPP_MODEL=/path/to/ggml-base.en.bin \
npm run test:cross
```

### Test Pattern

Uses Vitest with `test` and `expect`:

```typescript
import { test, expect } from 'vitest';

import { providers_default, models_default } from '#lib/config_defaults.ts';

test('all model provider_names exist in providers_default', () => {
	const model_provider_names = new Set(models_default.map((model) => model.provider_name));
	const provider_names = new Set(providers_default.map((provider) => provider.name));

	for (const provider_name of model_provider_names) {
		expect(
			provider_names.has(provider_name),
			`Provider "${provider_name}" does not exist in providers_default`
		).toBe(true);
	}
});
```

### Test File Naming

- `module.test.ts` — `action_event.test.ts`
- `module.aspect.test.ts` — `cell.svelte.base.test.ts`, `cell.svelte.decoders.test.ts`, `indexed_collection.svelte.queries.test.ts`

## Code Style

### Naming

- Variables/functions — `snake_case`. Example: `send_message`, `user_input`
- Classes — `PascalCase`. Example: `ChatView`, `ActionDispatcher`
- Types/interfaces — `PascalCase`. Example: `ChatOptions`, `ActionSpec`
- Schemas — `PascalCase`. Example: `ChatJson`, `CompletionRequest`
- Private fields — `#field`. Example: `#internal_state`

### Code Markers

- `// @slop [Model]` — LLM-generated code needing review
- `// TODO` — Work item
- `// TODO @many` — Affects multiple locations
- `// TODO @api` — API design question
- `// TODO @db` — Database-related

### Import Order

1. External packages (`svelte`, `@fuzdev/fuz_schema`, etc.)
2. Subpath imports and SvelteKit modules (`#lib/...`, `$app/...`)
3. Relative imports (`./...`)

```typescript
import { object, string } from '@fuzdev/fuz_schema/schema.ts';
import { SvelteMap } from 'svelte/reactivity';

import { Cell } from '#lib/cell.svelte.ts';
import type { Frontend } from '#lib/frontend.svelte.ts';

import { helper_function } from './helpers.ts';
```

Imports use the real source extension (`.ts` / `.svelte.ts` / `.svelte`) —
library code (`src/lib`) imports relative, while `src/routes` and `src/test`
use the `#lib/*` / `#routes/*` subpath imports from `package.json`.

### Svelte 5 Runes in State Classes

```typescript
// Schema fields — $state.raw()! by default, initialized by Cell.init()
name: string = $state.raw()!;

// $state()! only for arrays/objects mutated in place (push, splice, etc.)
thread_ids: Array<Uuid> = $state()!;

// Derived values
readonly doubled = $derived(this.count * 2);
readonly complex = $derived.by(() => expensiveCalculation(this.count));
```

No `$effect` in Cell classes — effects belong in Svelte components only.

A Cell's `$derived` fields are owned by the effect running when it's
constructed, so a Cell that outlives a component is never constructed in its
init, `onMount`, or an `$effect` directly: wrap the construction in `create_detached`
(`reactive_helpers.svelte.ts`) — or its deriveds can freeze when the component
unmounts. Event handlers and async code are safe.

### Error Handling

```typescript
// Structured JSON-RPC errors
throw jsonrpc_errors.invalid_params('Missing required field');
throw jsonrpc_errors.ai_provider_error(provider_name, error_message);

// Let ThrownJsonrpcError bubble through
if (error instanceof ThrownJsonrpcError) {
	throw error;
}
```
