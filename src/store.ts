import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Order } from './order.js';

export interface SavedOrder {
  order_id: string; payload: string; contact_id: string | null; deal_id: string | null;
  synced: number; uncertain: number;
}
export interface Attempt {
  id: number; order_id: string; status: string; contact_id: string | null;
  deal_id: string | null; error: string | null; timestamp: string;
}

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY, payload TEXT NOT NULL, contact_id TEXT, deal_id TEXT,
        synced INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, status TEXT NOT NULL,
        contact_id TEXT, deal_id TEXT, error TEXT, timestamp TEXT NOT NULL
      );
      UPDATE attempts SET status='failed', error='Server stopped during sync. Retry to recover.' WHERE status='processing';
    `);
  }
  save(order: Order) {
    this.db.prepare('INSERT OR IGNORE INTO orders (order_id,payload) VALUES (?,?)').run(order.order_id, JSON.stringify(order));
    return this.get(order.order_id)!;
  }
  get(id: string) { return this.db.prepare('SELECT * FROM orders WHERE order_id=?').get(id) as unknown as SavedOrder | undefined; }
  update(id: string, contact: string | null, deal: string | null, synced: boolean, uncertain: boolean) {
    this.db.prepare('UPDATE orders SET contact_id=?,deal_id=?,synced=?,uncertain=? WHERE order_id=?')
      .run(contact, deal, Number(synced), Number(uncertain), id);
  }
  begin(id: string) {
    return Number(this.db.prepare("INSERT INTO attempts (order_id,status,timestamp) VALUES (?,'processing',?)")
      .run(id, new Date().toISOString()).lastInsertRowid);
  }
  finish(id: number, status: string, contact: string | null, deal: string | null, error: string | null = null) {
    this.db.prepare('UPDATE attempts SET status=?,contact_id=?,deal_id=?,error=? WHERE id=?').run(status, contact, deal, error, id);
    return this.attempt(id)!;
  }
  attempt(id: number) { return this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as unknown as Attempt | undefined; }
  latest() { return this.db.prepare('SELECT * FROM attempts ORDER BY id DESC LIMIT 50').all() as unknown as Attempt[]; }
  close() { this.db.close(); }
}
