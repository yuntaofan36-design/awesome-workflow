import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { PlatformConfig } from '@awesome-workflow/config';

import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;
export type DatabaseClient = ReturnType<typeof postgres>;
export const DATABASE = Symbol('DATABASE');
export const DATABASE_CLIENT = Symbol('DATABASE_CLIENT');

export function createDatabase(config: PlatformConfig): { client: DatabaseClient; database: Database } {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL');
  const client = postgres(config.DATABASE_URL, { max: 10, prepare: false });
  return { client, database: drizzle(client, { schema }) };
}
