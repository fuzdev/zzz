/**
 * Database schema initialization for zzz.
 *
 * Runs fuz_app auth migrations. No zzz-specific DDL yet
 * (all domain state is in-memory via Cells).
 *
 * @module
 */

import type {Db} from '@fuzdev/fuz_app/db/db.js';

/**
 * Initialize the zzz database schema.
 *
 * Currently only auth tables (from `create_app_backend`).
 * Zzz-specific tables will be added here when persistent state is needed.
 *
 * @param db - database instance
 */
export const init_zzz_schema = async (_db: Db): Promise<void> => {
	// Auth migrations are handled by create_app_backend.
	// Add zzz-specific DDL here when persistent state is needed.
};
