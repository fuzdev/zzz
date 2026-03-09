# zzz CLI

> Deno-compiled binary for the zzz daemon — `zzz`

Entry point for the zzz global daemon. Compiled to a standalone binary via
`gro_plugin_deno_compile`. Follows the tx CLI pattern.

Deno is a shortcut — long-term, the CLI and daemon migrate to Rust fuz/fuzd.

## Architecture

```
zzz CLI (compiled Deno binary, thin client)
    │
    ├── Auto-starts daemon if not running (Phase 2)
    ├── Sends RPC to daemon
    └── Opens browser tab
    │
    ▼
zzz daemon (Hono server on Deno, single process)
    ├── Global state at ~/.zzz/
    ├── PGlite for persistence (planned)
    ├── JSON-RPC 2.0 over HTTP + WebSocket
    └── Serves prerendered SvelteKit frontend (planned)
```

One server, one port, one frontend. The SPA handles navigation between views.
All existing zzz features (chat, files, prompts, AI providers) coexist with
workspace management.

## Commands

```bash
zzz                          # start daemon if needed, open browser
zzz <file>                   # open browser focused on file
zzz <dir>                    # open browser scoped to directory

zzz init                     # initialize ~/.zzz/
zzz daemon start             # start daemon (foreground)
zzz daemon stop              # stop daemon
zzz daemon status            # show daemon info
zzz status                   # show what's loaded/watched
```

The default (no command, or path argument) auto-starts the daemon and opens
a browser — the `code .` equivalent.

## State Directory: `~/.zzz/`

```
~/.zzz/
  config.json                # Daemon config (port)
  state/db/                  # PGlite data (planned)
  run/daemon.json            # PID, port, version (ephemeral)
  cache/                     # Regenerable data
```

## Files

```
src/lib/zzz/
├── main.ts              # Entry point (deno compile target)
├── cli.ts               # parse_zzz_args, show_help, show_version
├── cli_config.ts        # ~/.zzz/config.json schema, load/save
├── build_info.ts        # VERSION, NAME constants
├── zod.ts               # Zod schema introspection for CLI help generation
├── runtime/
│   ├── types.ts         # ZzzRuntime interface (env, process, fs, commands, I/O)
│   └── deno.ts          # Deno implementation via create_deno_runtime()
├── cli/
│   ├── cli_args.ts      # Global flags, dispatch(), create_subcommand_router()
│   ├── cli_help.ts      # Command registry, help via create_help (from fuz_app)
│   └── schemas.ts       # Per-command Zod schemas
└── commands/
    ├── init.ts          # zzz init — create ~/.zzz/ directory structure
    ├── daemon.ts        # zzz daemon start|stop|status
    ├── open.ts          # zzz [path] — default command, opens browser
    └── status.ts        # zzz status — daemon + workspace info
```

## Key Patterns

### ZzzRuntime

Injectable runtime abstraction. `ZzzRuntime` is a type alias for `RuntimeDeps`
from `@fuzdev/fuz_app/runtime/deps.js`. Functions should accept narrow
`*Deps` interfaces (`EnvDeps`, `FsReadDeps`, etc.) from fuz_app.

### CLI Dispatch

Three-phase arg parsing:

1. `argv_parse()` from fuz_util — raw tokenization
2. `extract_global_flags()` — `--help`, `--version`
3. Per-command Zod schema validation via `dispatch()`

Nested commands (e.g., `zzz daemon start`) use `create_subcommand_router()`.

### Path-as-Command

If the first positional isn't a known command, it's treated as a path argument
to the `open` command. So `zzz ~/dev/` and `zzz open ~/dev/` are equivalent.

### Daemon Lifecycle

`daemon.json` at `~/.zzz/run/daemon.json` tracks PID, port, version. Managed
via `@fuzdev/fuz_app/cli/daemon.js` helpers (`write_daemon_info`,
`read_daemon_info`, `is_daemon_running`, `stop_daemon`). Written atomically
(temp file + rename). CLI checks if PID is alive via `kill -0`. Stale files
are cleaned up automatically.

## Build

Binary compiled during `gro build` via `gro_plugin_deno_compile`:

- Input: `src/lib/zzz/main.ts`
- Output: `dist_cli/zzz`
- Flags: `--no-check`, `--sloppy-imports`
- Install: `deno task install` → `~/.zzz/bin/zzz`

Config: `deno.json` (imports, tasks, excludes) + `gro.config.ts` (plugin setup).

## Server Entry Point

`src/lib/server/server_deno.ts` — Deno entry point, wired to `zzz daemon start`.
Calls the shared `create_zzz_app()` factory (in `create_zzz_app.ts`) which builds
the full Hono app with Backend, AI providers, WebSocket, and HTTP RPC endpoints.
Env is loaded via `server_env.ts` (runtime-agnostic, no `$env` dependency).

The Node.js entry (`server.ts`) calls the same factory for SvelteKit dev mode,
passing `$env` values as defaults.

## Development

```bash
# Run CLI directly (no compile needed)
deno run --allow-all src/lib/zzz/main.ts --help
deno run --allow-all src/lib/zzz/main.ts daemon start

# Type check Deno files
deno check src/lib/zzz/main.ts

# Build compiled binary
gro build
./dist_cli/zzz --help

# Install to ~/.zzz/bin/
deno task install
```

## Dependencies

From `@fuzdev/fuz_util`: `argv_parse`, `args_parse` (CLI args).
From `@fuzdev/fuz_app`: CLI daemon helpers, config, help, util; ActionSpec types.
From `hono`: HTTP server framework.
From `zod`: Schema validation (v4, with `.meta()` for CLI descriptions).
