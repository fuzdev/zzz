/**
 * Server-side constants (Deno-compile-safe).
 *
 * Mirror of `src/lib/constants.ts` for modules in the Deno compile chain.
 * Must not import `$env/static/public` or any SvelteKit build-time module —
 * those don't exist in Deno and crash `gro build` / `deno compile`.
 *
 * @module
 */

import {DEV} from 'esm-env';

/**
 * Canonical env file path for daemon-initiated reads and writes.
 *
 * The write target must match a file that's reloaded on next daemon start,
 * so user-entered values (e.g. API keys via `provider_update_api_key`)
 * survive restart:
 *
 * - **Dev** (`gro dev`, `deno task dev`): both Vite and `scripts/dev.ts`
 *   reload `.env.development`. `.env` is shadowed by `.env.development` in
 *   Vite's mode-precedence and is not loaded at all by `scripts/dev.ts`,
 *   so writing to `.env` in dev would be invisible on restart.
 * - **Prod** (compiled `zzz daemon start`): `server.ts` loads `.env` via
 *   `load_env_file`. `.env.production` is NOT loaded by the compiled daemon
 *   (only by `deno task preview`'s `--env=.env.production` flag), so writing
 *   there would be invisible on restart.
 */
export const ENV_FILE: string = DEV ? '.env.development' : '.env';
