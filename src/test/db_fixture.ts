/**
 * PGlite database fixture for zzz tests.
 *
 * Follows the fuz_app consumer pattern: init_schema runs auth migrations,
 * describe_db provides per-factory test suite scoping with automatic truncation.
 *
 * @module
 */

import {
	create_pglite_factory,
	create_pg_factory,
	create_describe_db,
	log_db_factory_status,
	drop_auth_schema,
	AUTH_INTEGRATION_TRUNCATE_TABLES,
	type DbFactory,
} from '@fuzdev/fuz_app/testing/db.js';
import {run_migrations} from '@fuzdev/fuz_app/db/migrate.js';
import {AUTH_MIGRATION_NS} from '@fuzdev/fuz_app/auth/migrations.js';
import type {Db} from '@fuzdev/fuz_app/db/db.js';

import {init_zzz_schema} from '$lib/server/db/zzz_schema.js';

const init_schema = async (db: Db): Promise<void> => {
	await drop_auth_schema(db);
	await run_migrations(db, [AUTH_MIGRATION_NS]);
	await init_zzz_schema(db); // no-op currently — wired for future zzz-specific DDL
};

// No zzz-specific tables yet — auth tables only
const TRUNCATE_TABLES = AUTH_INTEGRATION_TRUNCATE_TABLES;

export const pglite_factory = create_pglite_factory(init_schema);

const pg_factory = create_pg_factory(init_schema, process.env.TEST_DATABASE_URL);

export const db_factories: Array<DbFactory> = [pglite_factory, pg_factory];

log_db_factory_status(db_factories);

export const describe_db = create_describe_db([pglite_factory], TRUNCATE_TABLES);
