import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niches_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  niches_json TEXT NOT NULL,
  raw_payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  platform TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  views INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  raw_payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_creator ON social_accounts (creator_id, id);
CREATE INDEX IF NOT EXISTS metrics_latest ON metrics (account_id, captured_at DESC, id DESC, views);
CREATE INDEX IF NOT EXISTS deliveries_creator_date ON deliveries (creator_id, delivered_at);
`;

type SqlValue = string | number | bigint | null;

let queryCount = 0;

export function resetQueryCount(): void {
  queryCount = 0;
}

export function getQueryCount(): number {
  return queryCount;
}

export function openDatabase(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  // SQLite ordena texto por UTF-8; o contrato original compara unidades UTF-16 do JavaScript.
  db.function("js_string_key", { deterministic: true }, (value) =>
    Buffer.from(String(value), "utf16le").swap16(),
  );
  db.exec(SCHEMA);
  return db;
}

/** Leituras síncronas: contam como query, e como não cedem a vez entre uma e outra, nada as separa de uma escrita. */
export function allNow<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): T[] {
  queryCount += 1;
  return db.prepare(sql).all(...params) as T[];
}

export function getNow<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): T | undefined {
  queryCount += 1;
  const row = db.prepare(sql).get(...params);
  return row === undefined || row === null ? undefined : (row as T);
}

/**
 * Executa várias leituras como um único retrato do banco. Duas proteções: a função é síncrona (nenhum outro tratador da mesma
 * conexão roda no meio) e o BEGIN/COMMIT fixa o retrato para quem escreve por outra conexão (em WAL, a leitura enxerga um
 * estado só). Não pode conter `await`: segurar uma transação aberta por cima de espera é o que isso evita.
 */
export function readSnapshot<T>(db: DatabaseSync, read: () => T): T {
  db.exec("BEGIN");
  try {
    return read();
  } finally {
    db.exec("COMMIT");
  }
}

export async function all<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): Promise<T[]> {
  queryCount += 1;
  return db.prepare(sql).all(...params) as T[];
}

export async function get<T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): Promise<T | undefined> {
  queryCount += 1;
  const row = db.prepare(sql).get(...params);
  if (row === undefined || row === null) return undefined;
  return row as T;
}
