# Zzz

[<img src="/static/logo.svg" alt="three sleepy z's" align="right" width="192" height="192">](https://www.zzz.software/)

> nice web things for the tired 💤

⚠️ early pre-release, does not persist your data yet

**[zzz.software](https://www.zzz.software/)**

Zzz, pronounced "zees" like bees,
is a software garage for power users and devs.
The idea is to make an integrated cross-platform environment that adapts to
your needs and intent while remaining fully open, aligned, and designed for your autonomy.
It's both a customizable web UI and local-first backend for power users,
and a flexible tool for crafting UX-maximizing websites
with a streamlined developer experience, eventually accessible to non-coders (hence all the AI).

More at [zzz.software/about](https://www.zzz.software/about).

This is an early stage project and the ideas are still developing -
see the issues and [discussions](https://github.com/fuzdev/zzz/discussions).

## Setup

This project is in its early stages, and installing it
currently requires some basic technical skills.
Eventually there will be a desktop app but
for now you'll need Node (>=24.14), a Rust toolchain (for the backend),
PostgreSQL, and Git to clone the repo.

Running Zzz locally in development (`cargo xtask dev`) is the supported way to use it right now.
It deploys via SvelteKit's static adapter with diminished capabilities
([zzz.software](https://www.zzz.software/)),
and the full app is served by the Rust `zzz_server` backend.

> The Rust backend depends on sibling crates from the fuz workspace via path
> dependencies (including the native `fuz_pty` terminal crate). They must be
> checked out alongside this repo for `cargo build` to succeed; until they're
> published, building from a bare clone isn't yet reproducible.

> Developing on Windows
> requires something like [WSL](https://learn.microsoft.com/en-us/windows/wsl/install).

After cloning, from the project root:

```bash
# 1. Create the PostgreSQL database the backend connects to
createdb zzz

# 2. Generate .env.development (idempotent — safe to re-run)
cargo xtask dev-setup

# 3. Install Node dependencies
npm install

# 4. Build the Rust backend and start everything (backend + Vite frontend)
cargo xtask dev
```

You can edit `.env.development` with your API keys,
or update them at runtime on the `/capabilities` page.

Browse to the location it says, probably `localhost:5173`.

On first run Zzz has no account yet, so it shows a bootstrap form. Copy the
one-time token it points to (`cat .zzz/bootstrap_token`), paste it in, and pick a
username and password to create your admin account — then you're logged in and
ready.

## Roadmap

- [#7 integrate database](https://github.com/fuzdev/zzz/issues/7)
- [#8 undo/history system](https://github.com/fuzdev/zzz/issues/8)
- publish to npm
- input welcome

## Credits 🐢<sub>🐢</sub><sub><sub>🐢</sub></sub>

Zzz builds on a great deal of software.

- see the deps in `package.json`
- I started using [Claude](https://claude.ai/) in late 2024 after making the initial prototype,
  and in late 2025 I started doing much of the coding with Claude Code, Opus 4.5
  being the first over some threshold for me for this project
  - see `NOTE: AI-generated` and similar disclaimers

## Contributing

[fuz.dev/contributing](https://www.fuz.dev/contributing)

## License 🐦

[MIT](LICENSE)
