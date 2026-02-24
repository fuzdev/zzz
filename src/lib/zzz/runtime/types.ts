/**
 * Runtime type alias for zzz.
 *
 * The full runtime interface is shared via `DenoRuntime` from fuz_app.
 * `ZzzRuntime` is a project-local alias used throughout the CLI code.
 *
 * Functions should accept narrow `*Deps` interfaces from
 * `@fuzdev/fuz_app/cli/runtime.js`, not the full `ZzzRuntime`.
 *
 * @module
 */

import type {DenoRuntime} from '@fuzdev/fuz_app/cli/runtime_deno.js';

/**
 * Unified runtime abstraction for zzz CLI operations.
 *
 * Provides all runtime primitives as injectable dependencies.
 * Functions should accept partial interfaces via `Pick<ZzzRuntime, ...>`
 * or better yet, narrow `*Deps` interfaces from fuz_app.
 */
export type ZzzRuntime = DenoRuntime;
