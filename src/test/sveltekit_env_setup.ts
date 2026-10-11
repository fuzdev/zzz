// SvelteKit's dev client module for `$app/env/public` (what `src/lib/constants.ts`
// imports, resolved through the browser condition in tests) reads the env from
// `globalThis.__sveltekit_dev`, which kit's dev server injects into the page — vitest
// has no page, so stub the global; the vars are all static, so they're inlined in the
// module and this `env` is never read
const sveltekit_global = globalThis as { __sveltekit_dev?: { env: Record<string, string> } };
sveltekit_global.__sveltekit_dev ??= { env: {} };
