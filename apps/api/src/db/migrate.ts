import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { z } from 'zod';

import { drizzle } from 'drizzle-orm/postgres-js';

const databaseUrl = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'DATABASE_URL must use PostgreSQL',
  )
  .parse(process.env.DATABASE_URL);

const client = postgres(databaseUrl, { max: 1, prepare: false });
try {
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
  });
} finally {
  await client.end();
}
