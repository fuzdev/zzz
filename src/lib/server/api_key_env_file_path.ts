/**
 * Persistence target for user-entered AI provider API keys.
 *
 * @module
 */

import {DEV} from 'esm-env';

/**
 * Env file path where `provider_update_api_key` writes API keys.
 *
 * The write target must match a file that's reloaded on next daemon start,
 * so user-entered keys survive restart:
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
export const API_KEY_ENV_FILE_PATH: string = DEV ? '.env.development' : '.env';
