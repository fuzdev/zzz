# Zzz

[<img src="/static/logo.svg" alt="three sleepy z's" align="right" width="192" height="192">](https://www.zzz.software/)

> nice web things for the tired 💤

⚠️ early pre-release, does not persist your data yet

**[zzz.software](https://www.zzz.software/)**

Zzz, pronounced "zees" like bees,
is a local-first forge for power users and developers.
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
for now you'll need Node 22.15+
(YMMV with Deno/Bun/etc, although Deno will be used for deployment soon)
and Git to clone the repo.

Running Zzz locally in development with Node is the supported way to use it right now.
It deploys via SvelteKit's static adapter with diminished capabilities
([zzz.software](https://www.zzz.software/)),
and it will have a production build with the Node adapter and Hono server soon.

> Developing on Windows
> requires something like [WSL](https://learn.microsoft.com/en-us/windows/wsl/install).

To run Zzz, we need an `.env.development` file in your project root.

In your terminal, copy over
[src/lib/server/.env.development.example](/src/lib/server/.env.development.example):

```bash
cp src/lib/server/.env.development.example .env.development --update=none
```

You can edit `.env.development` with your API keys,
or update them at runtime on the `/capabilities` page.

Then:

```bash
npm run dev
```

Browse to the location is says, probably `localhost:5173`.

## Roadmap

- [#7 integrate database](https://github.com/fuzdev/zzz/issues/7)
- [#8 undo/history system](https://github.com/fuzdev/zzz/issues/8)
- publish to npm
- input welcome

## Credits 🐢<sub>🐢</sub><sub><sub>🐢</sub></sub>

Zzz builds on a great deal of software.

- see the deps in [package.json](package.json)
- I started using [Claude](https://claude.ai/) in late 2024 after making the initial prototype,
  and in late 2025 I started doing much of the coding with Claude Code, Opus 4.5
  being the first over some threshold for me for this project
  - see `NOTE: AI-generated, human-reviewed` and similar disclaimers

## License 🐦

[MIT](LICENSE)
