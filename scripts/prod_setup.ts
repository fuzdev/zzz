/**
 * Production environment setup.
 *
 * Idempotent — safe to re-run. Skips steps that are already done.
 *
 * Usage: deno task prod:setup
 *
 * @module
 */

import {setup_env_file} from '@fuzdev/fuz_app/dev/setup.js';

import {runtime, set_permissions} from './setup_helpers.ts';

console.log('zzz prod setup');
console.log();

console.log('Environment file:');
await setup_env_file(runtime, '.env.production', '.env.production.example', {set_permissions});
console.log();

console.log('Done.');
