/**
 * First-time development environment setup.
 *
 * Idempotent — safe to re-run. Skips steps that are already done.
 *
 * Usage: deno task dev:setup
 *
 * @module
 */

import {setup_env_file} from '@fuzdev/fuz_app/dev/setup.js';

import {runtime, set_permissions} from './setup_helpers.ts';

console.log('zzz dev setup');
console.log();

console.log('Environment file:');
await setup_env_file(runtime, '.env.development', '.env.development.example', {set_permissions});
console.log();

console.log('Done. Next: gro dev');
