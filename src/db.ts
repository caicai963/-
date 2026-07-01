import Database from 'better-sqlite3';
import { resolve } from 'path';

const DB_PATH = resolve(__dirname, '..', 'data', 'epc.db');
let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables(db);
  }
  return db;
}

function initTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS epc_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_order_no TEXT NOT NULL,
      payee_name TEXT,
      payee_phone TEXT,
      amount REAL,
      actual_amount REAL,
      status_node TEXT,
      status_text TEXT,
      paid INTEGER DEFAULT 0,
      paid_time TEXT,
      raw_json TEXT,
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_payments_order ON epc_payments(internal_order_no);
    CREATE INDEX IF NOT EXISTS idx_payments_name_phone ON epc_payments(payee_name, payee_phone);

    CREATE TABLE IF NOT EXISTS order_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_order_no TEXT NOT NULL UNIQUE,
      internal_order_no TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mapping_external ON order_mapping(external_order_no);

    CREATE TABLE IF NOT EXISTS tab_scrape_state (
      tab_name TEXT PRIMARY KEY,
      scraped_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
}

export interface EpcPayment {
  internal_order_no: string;
  payee_name: string | null;
  payee_phone: string | null;
  amount: number | null;
  actual_amount: number | null;
  status_node: string | null;
  status_text: string | null;
  paid: boolean;
  paid_time: string | null;
  updated_at: string;
}

export interface OrderMapping {
  external_order_no: string;
  internal_order_no: string;
}

export function upsertPayments(payments: Omit<EpcPayment, 'updated_at'>[]): number {
  const db = getDb();

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique
    ON epc_payments(internal_order_no, payee_name, payee_phone)
  `);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO epc_payments (internal_order_no, payee_name, payee_phone, amount, actual_amount, status_node, status_text, paid, paid_time, updated_at)
    VALUES (@internal_order_no, @payee_name, @payee_phone, @amount, @actual_amount, @status_node, @status_text, @paid, @paid_time, datetime('now','localtime'))
  `);

  const insertMany = db.transaction((items: Omit<EpcPayment, 'updated_at'>[]) => {
    let count = 0;
    for (const item of items) {
      stmt.run({
        internal_order_no: item.internal_order_no,
        payee_name: item.payee_name,
        payee_phone: item.payee_phone,
        amount: item.amount,
        actual_amount: item.actual_amount,
        status_node: item.status_node,
        status_text: item.status_text,
        paid: item.paid ? 1 : 0,
        paid_time: item.paid_time,
      });
      count++;
    }
    return count;
  });

  return insertMany(payments);
}

export function importMappings(mappings: OrderMapping[]): { inserted: number; skipped: number } {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO order_mapping (external_order_no, internal_order_no)
    VALUES (@external_order_no, @internal_order_no)
  `);

  let inserted = 0;
  let skipped = 0;

  const insertMany = db.transaction((items: OrderMapping[]) => {
    for (const item of items) {
      if (!item.external_order_no || !item.internal_order_no) {
        skipped++;
        continue;
      }
      stmt.run(item);
      inserted++;
    }
  });

  insertMany(mappings);
  return { inserted, skipped };
}

export interface QueryResult {
  found: boolean;
  external_order_no: string;
  input_name: string;
  input_phone: string;
  payment: EpcPayment | null;
}

export function queryPayment(externalOrderNo: string, name?: string, phone?: string): QueryResult {
  const db = getDb();

  const mapping = db.prepare(
    'SELECT internal_order_no FROM order_mapping WHERE external_order_no = ?'
  ).get(externalOrderNo) as { internal_order_no: string } | undefined;

  if (!mapping) {
    return { found: false, external_order_no: externalOrderNo, input_name: name || '', input_phone: phone || '', payment: null };
  }

  interface SqliteRow {
    internal_order_no: string;
    payee_name: string | null;
    payee_phone: string | null;
    amount: number | null;
    actual_amount: number | null;
    status_node: string | null;
    status_text: string | null;
    paid: number;
    paid_time: string | null;
    updated_at: string;
  }

  let row: SqliteRow | undefined;

  if (name && phone) {
    row = db.prepare(`
      SELECT * FROM epc_payments
      WHERE internal_order_no = ? AND payee_name = ? AND payee_phone = ?
    `).get(mapping.internal_order_no, name, phone) as SqliteRow | undefined;
  }

  if (!row) {
    row = db.prepare(`
      SELECT * FROM epc_payments
      WHERE internal_order_no = ? LIMIT 1
    `).get(mapping.internal_order_no) as SqliteRow | undefined;
  }

  if (!row) {
    return { found: false, external_order_no: externalOrderNo, input_name: name || '', input_phone: phone || '', payment: null };
  }

  return {
    found: true,
    external_order_no: externalOrderNo,
    input_name: name || '',
    input_phone: phone || '',
    payment: {
      internal_order_no: row.internal_order_no,
      payee_name: row.payee_name,
      payee_phone: row.payee_phone,
      amount: row.amount,
      actual_amount: row.actual_amount,
      status_node: row.status_node,
      status_text: row.status_text,
      paid: row.paid === 1,
      paid_time: row.paid_time,
      updated_at: row.updated_at,
    },
  };
}

export function getStats(): { totalPayments: number; totalMappings: number; paidCount: number; lastUpdate: string | null } {
  const db = getDb();
  const totalPayments = (db.prepare('SELECT COUNT(*) as cnt FROM epc_payments').get() as { cnt: number }).cnt;
  const totalMappings = (db.prepare('SELECT COUNT(*) as cnt FROM order_mapping').get() as { cnt: number }).cnt;
  const paidCount = (db.prepare('SELECT COUNT(*) as cnt FROM epc_payments WHERE paid = 1').get() as { cnt: number }).cnt;
  const lastUpdate = (db.prepare('SELECT MAX(updated_at) as t FROM epc_payments').get() as { t: string | null }).t;
  return { totalPayments, totalMappings, paidCount, lastUpdate };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function isTabScraped(tabName: string): boolean {
  const database = getDb();
  const row = database.prepare(
    'SELECT scraped_at FROM tab_scrape_state WHERE tab_name = ?'
  ).get(tabName) as { scraped_at: string } | undefined;
  return !!row;
}

export function markTabScraped(tabName: string): void {
  const database = getDb();
  database.prepare(
    'INSERT OR REPLACE INTO tab_scrape_state (tab_name, scraped_at) VALUES (?, datetime(\'now\',\'localtime\'))'
  ).run(tabName);
}

export function resetTabScrape(tabName?: string): void {
  const database = getDb();
  if (tabName) {
    database.prepare('DELETE FROM tab_scrape_state WHERE tab_name = ?').run(tabName);
  } else {
    database.prepare('DELETE FROM tab_scrape_state').run();
  }
}

export function getExistingOrderNos(): Set<string> {
  const database = getDb();
  const rows = database.prepare('SELECT DISTINCT internal_order_no FROM epc_payments').all() as { internal_order_no: string }[];
  return new Set(rows.map(r => r.internal_order_no));
}

export function getOrderNosWithDetails(): Set<string> {
  const database = getDb();
  const rows = database.prepare('SELECT DISTINCT internal_order_no FROM epc_payments WHERE payee_name IS NOT NULL').all() as { internal_order_no: string }[];
  return new Set(rows.map(r => r.internal_order_no));
}

export function getPaidOrderNos(): Set<string> {
  const database = getDb();
  const rows = database.prepare('SELECT DISTINCT internal_order_no FROM epc_payments WHERE paid = 1').all() as { internal_order_no: string }[];
  return new Set(rows.map(r => r.internal_order_no));
}
