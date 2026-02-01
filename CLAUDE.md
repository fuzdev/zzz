# zzz

> nice web things for the tired 💤

zzz (`@fuzdev/zzz`) is a local-first IDE + CMS + browser + AI UI for power users
and developers. It runs as a server on your machine with a PostgreSQL database
backing a Svelte web frontend.

**Status**: Early pre-release, development use only (no auth yet)

For coding conventions, see [`fuz-stack`](../fuz-stack/CLAUDE.md).

## Contents

- [Quick Reference](#quick-reference)
- [What is Zzz?](#what-is-zzz)
- [Architecture Overview](#architecture-overview)
- [Tech Stack](#tech-stack)
- [Directory Structure](#directory-structure)
- [Zzz App Directory](#zzz-app-directory)
- [Development](#development)
- [Documentation](#documentation)

## Quick Reference

| What                 | Where                                       |
| -------------------- | ------------------------------------------- |
| **Start dev server** | `gro dev` or `npm run dev`                  |
| **Run tests**        | `gro test` or `npm run test`                |
| **Type check**       | `gro typecheck` or `npm run typecheck`      |
| **Build**            | `gro build` or `npm run build`              |
| **Action specs**     | `src/lib/action_specs.ts`                   |
| **State classes**    | `src/lib/*.svelte.ts`                       |
| **UI components**    | `src/lib/*.svelte`                          |
| **Backend handlers** | `src/lib/server/backend_action_handlers.ts` |
| **AI providers**     | `src/lib/server/backend_provider_*.ts`      |

## What is Zzz?

Zzz combines multiple tools into one integrated environment:

- **IDE**: File editing with syntax highlighting, multi-tab support
- **CMS**: Content management with prompts, parts, and structured content
- **Browser**: Planned tabbed browsing integrated with the workspace (see `/tabs`)
- **AI UI**: Chat interface supporting multiple models and providers
- **Projects**: Website/app building with git integration (see `/projects`)

### Design Priorities

1. **Solo offline developer first**: Works without network, local PostgreSQL (pglite), local AI (Ollama)
2. **User agency**: Full control over tools and data, no third-party lock-in
3. **Local-first**: Sensitive data stays on your machine
4. **Protocol agnosticism**: JSON-RPC 2.0 foundation, planned MCP/A2A compatibility
5. **Extensibility**: Devs can extend without artificial restrictions

### Relationship to Fuz

Zzz demonstrates how far you can go in one direction with [Fuz](https://github.com/fuzdev/fuz_ui) - it's a maximal exploration of the stack for power users. The current Hono/Node backend is a **reference implementation**. The Fuz ecosystem includes a Rust daemon (`fuzd`) that will become the primary backend interface. Zzz's TypeScript backend demonstrates the architecture and may be deprecated once the Rust implementation matures.

## Architecture Overview

### Core Abstractions

| Abstraction           | Purpose                                          | Key Files                      |
| --------------------- | ------------------------------------------------ | ------------------------------ |
| **Cell**              | Schema-driven reactive state with Svelte 5 runes | `cell.svelte.ts`               |
| **Action**            | Symmetric RPC (frontend ↔ backend)              | `action_*.ts`                  |
| **IndexedCollection** | Queryable collections with multiple indexes      | `indexed_collection.svelte.ts` |
| **Transport**         | Protocol-agnostic communication                  | `transports.ts`                |

### Content Model

```
Chat → Thread[] → Turn[] → Part[]
                            ├── TextPart (direct content)
                            └── DiskfilePart (file reference)

Prompt → Part[] (reusable content templates)
```

- **Parts**: Content units that can be shared across turns
- **Turns**: Conversation messages with role (user/assistant/system)
- **Threads**: Linear conversation with a specific model
- **Chats**: Container for comparing multiple threads/models

### Action System

The action system is **symmetric and peer-to-peer**:

```typescript
// Both frontend and backend use ActionPeer
Frontend.peer.send(request)  →  Backend.peer.receive(message)
Backend.peer.send(notification)  →  Frontend.peer.receive(message)
```

**Action kinds**:

- `request_response`: Traditional RPC with response
- `remote_notification`: Fire-and-forget (backend → frontend for streaming)
- `local_call`: Frontend-only actions

See [docs/architecture.md](docs/architecture.md) for details.

## Tech Stack

| Layer          | Technology                                                            |
| -------------- | --------------------------------------------------------------------- |
| **Frontend**   | SvelteKit + Svelte 5 + TypeScript + Vite                              |
| **Backend**    | Hono + Node.js (reference impl)                                       |
| **Database**   | PostgreSQL (pglite for local, full Postgres for production) - planned |
| **Build**      | @ryanatkn/gro                                                         |
| **UI**         | @fuzdev/fuz_ui components, @fuzdev/fuz_css styling                    |
| **Validation** | Zod schemas                                                           |
| **AI**         | Ollama (local), Claude/ChatGPT/Gemini (BYOK)                          |

## Directory Structure

```
src/
├── lib/                      # Published as @fuzdev/zzz
│   ├── server/              # Backend (reference implementation)
│   │   ├── backend.ts       # Core backend class
│   │   ├── server.ts        # Hono server setup
│   │   ├── backend_provider_*.ts  # AI providers
│   │   ├── scoped_fs.ts     # Secure filesystem
│   │   └── security.ts      # Origin verification
│   │
│   ├── *.svelte.ts          # State classes (Cell subclasses)
│   │   ├── frontend.svelte.ts   # Root app state
│   │   ├── chat.svelte.ts       # Chat state
│   │   ├── thread.svelte.ts     # Thread state
│   │   ├── turn.svelte.ts       # Turn state
│   │   └── part.svelte.ts       # Content parts
│   │
│   ├── action_*.ts          # Action system
│   │   ├── action_spec.ts   # Action metadata schemas
│   │   ├── action_specs.ts  # All action definitions
│   │   ├── action_event.ts  # Lifecycle state machine
│   │   └── action_peer.ts   # Symmetric communication
│   │
│   └── *.svelte             # UI components
│       ├── Chat*.svelte     # Chat UI
│       ├── Diskfile*.svelte # File editor UI
│       ├── Model*.svelte    # Model management UI
│       └── ...
│
└── routes/                  # SvelteKit routes
    ├── chats/              # AI chat interface
    ├── files/              # File editor
    ├── models/             # Model catalog
    ├── prompts/            # Prompt builder
    ├── providers/          # AI provider config
    ├── projects/           # Project management (futuremode)
    ├── tabs/               # Browser tabs (futuremode)
    └── about/              # About page
```

## Zzz App Directory

The `.zzz/` directory stores Zzz's app data. Configured via `PUBLIC_ZZZ_DIR` env var.

```
.zzz/
├── state/                   # Persistent data
│   └── completions/         # AI completion logs
├── cache/                   # Regenerable data (future)
└── run/                     # Runtime ephemeral
    └── server.json          # PID, port, version
```

| Directory | Semantics                               |
| --------- | --------------------------------------- |
| `state/`  | Persistent user data, survives restarts |
| `cache/`  | Regenerable data, safe to delete        |
| `run/`    | Runtime/ephemeral (PIDs, locks)         |

The `run/server.json` file is written on server startup and removed on clean shutdown. It contains PID, port, start time, and version for server discovery.

### Scoped Filesystem

Zzz separates two filesystem concerns:

| Env Var                  | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `PUBLIC_ZZZ_DIR`         | Zzz's app directory (default: `.zzz`)               |
| `PUBLIC_ZZZ_SCOPED_DIRS` | Comma-separated paths Zzz can access for user files |

Example:

```bash
PUBLIC_ZZZ_DIR="./.zzz"
PUBLIC_ZZZ_SCOPED_DIRS="./projects,~/code,/mnt/data"
```

The `zzz_dir` is always watched and accessible (for app data like completions). `scoped_dirs` adds additional paths for user files.

## Development

### Setup

```bash
# Copy env template
cp src/lib/server/.env.development.example .env.development

# Install dependencies
npm install

# Start development server
gro dev
```

### Commands

| Command         | Description                    |
| --------------- | ------------------------------ |
| `gro dev`       | Development server with HMR    |
| `gro build`     | Production build               |
| `gro test`      | Run test suite                 |
| `gro typecheck` | Type checking                  |
| `gro check`     | All checks (types, lint, test) |
| `gro deploy`    | Deploy to production           |

### Naming Conventions

| Type             | Convention             | Example           |
| ---------------- | ---------------------- | ----------------- |
| TypeScript files | `snake_case.ts`        | `action_peer.ts`  |
| Svelte 5 modules | `snake_case.svelte.ts` | `chat.svelte.ts`  |
| Components       | `PascalCase.svelte`    | `ChatView.svelte` |
| Tests            | `*.test.ts`            | `cell.test.ts`    |

### Code Markers

- `// @slop [Model]`: LLM-generated code for review
- Core interfaces are hand-crafted; implementations may use LLM assistance

## Documentation

| Document                                     | Contents                                             |
| -------------------------------------------- | ---------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | Action system, Cell system, content model, data flow |
| [docs/development.md](docs/development.md)   | Development workflow, extension points, patterns     |
| [docs/providers.md](docs/providers.md)       | AI provider integration, adding new providers        |

## Values

- **User agency**: Control over tools and data
- **Fullstack unification**: Single TypeScript runtime (frontend + backend)
- **Protocol agnosticism**: Broad compatibility (JSON-RPC, MCP, A2A)
- **Extensibility**: Without prescription
- **Open standards**: Interoperability with the web ecosystem
- **Security by design**: UX makes safe choices easy

## Planned Features

- Database integration (PostgreSQL via pglite) - [#7](https://github.com/fuzdev/zzz/issues/7)
- Undo/history system - [#8](https://github.com/fuzdev/zzz/issues/8)
- Authentication system
- MCP/A2A protocol support
- Terminal integration
- Git integration
- RSS/Atom/JSON Feed support
- Native app with browser engine integration

## Security

⚠️ **No authentication yet** - development use only

Current security measures:

- **ScopedFs**: Filesystem restricted to `.zzz` directory
- **Origin verification**: CORS-like checks via `ALLOWED_ORIGINS`
- **CSP**: Strict Content Security Policy
- **No symlinks**: Path traversal protection

See the [security section](/about) for detailed information.
