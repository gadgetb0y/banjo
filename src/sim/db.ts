/**
 * The sim's own database (banjo_sim), shared by `npm run sim` and the evals
 * (#188). Imports src/db only when emptying, so a caller can apply the sim's
 * environment before anything loads src/config.
 */
import postgres from 'postgres';
import { SIM_DATABASE } from './env.js';

/** Creates banjo_sim on the configured server if it isn't there yet. Throws, with how to start Postgres, if the server can't be reached. */
export async function ensureSimDatabase(simUrl: string): Promise<void> {
  const url = new URL(simUrl);
  url.pathname = '/postgres';
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await admin`select 1 as ok from pg_database where datname = ${SIM_DATABASE}`;
    if (!row) await admin.unsafe(`create database ${SIM_DATABASE}`);
  } catch (err) {
    const where = `${url.hostname}:${url.port || 5432}`;
    throw new Error(`Can't reach Postgres at ${where} (${(err as Error).message}). Start it with: docker compose up -d postgres`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Every table in banjo_sim, emptied — after checking it really is banjo_sim. */
export async function emptySimDatabase(): Promise<void> {
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../db/index.js');
  const [{ name }] = (await db.execute(sql`select current_database() as name`)) as unknown as [{ name: string }];
  if (name !== SIM_DATABASE) throw new Error(`Refusing to empty "${name}": the sim only ever clears ${SIM_DATABASE}.`);
  const tables = (await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { tablename: string }[];
  if (!tables.length) return;
  const list = tables.map(({ tablename }) => `"${tablename.replace(/"/g, '""')}"`).join(', ');
  await db.execute(sql.raw(`truncate ${list} restart identity cascade`));
}
