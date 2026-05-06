/**
 * Zzz-specific setup helpers.
 *
 * Provides the Deno runtime and permissions callback for zzz setup scripts.
 * Setup utilities are imported directly from `@fuzdev/fuz_app/dev/setup`.
 *
 * @module
 */

import {create_deno_runtime} from '@fuzdev/fuz_app/runtime/deno.js';

/** Deno runtime for zzz setup scripts. */
export const runtime = create_deno_runtime([]);

/** Set file permissions (wrapper around Deno.chmod). */
export const set_permissions = (path: string, mode: number): Promise<void> => Deno.chmod(path, mode);
