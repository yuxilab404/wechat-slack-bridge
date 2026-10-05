import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { Fault } from "./http.js";
export class Store {
  db: DatabaseSync;
  constructor(public c: Config) {
    mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(c.stateDir, 0o700);
    this.db = new DatabaseSync(join(c.stateDir, "bridge.sqlite"));
    chmodSync(join(c.stateDir, "bridge.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound(id TEXT PRIMARY KEY,payload TEXT NOT NULL,context TEXT NOT NULL,sender TEXT NOT NULL,created INTEGER NOT NULL,root TEXT UNIQUE,source_ts TEXT,final INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,payload TEXT NOT NULL,due INTEGER NOT NULL,created INTEGER NOT NULL,version TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,source TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',due INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,error TEXT);
    `);
    this.db.exec(
      "UPDATE jobs SET status='uncertain', error='进程退出时发送结果不确定' WHERE status='sending'",
    );
    this.cleanup();
  }
  get(sql: string, ...args: any[]): any {
    return this.db.prepare(sql).get(...args);
  }
  all(sql: string, ...args: any[]): any[] {
    return this.db.prepare(sql).all(...args);
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  capacity() {
    const p = this.get("PRAGMA page_count").page_count;
    const s = this.get("PRAGMA page_size").page_size;
    if (p * s >= this.c.maxStateBytes)
      throw new Fault("状态容量已满，请维护后重启");
  }
  meta(k: string): string {
    return this.get("SELECT v FROM meta WHERE k=?", k)?.v ?? "";
  }
  set(k: string, v: string) {
    this.run(
      "INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
      k,
      v,
    );
  }
  job(id: string, source: string, kind: string, payload: any) {
    this.run(
      "INSERT OR IGNORE INTO jobs(id,source,kind,payload,created) VALUES(?,?,?,?,?)",
      id,
      source,
      kind,
      JSON.stringify(payload),
      Date.now(),
    );
  }
  expirePending() {
    const cutoff = Date.now() - this.c.ttlMs;
    this.run(
      "UPDATE jobs SET status='failed',payload='{}',error='任务已过期' WHERE status='pending' AND (created<=? OR source IN (SELECT id FROM inbound WHERE created<=?))",
      cutoff,
      cutoff,
    );
  }
  cleanup() {
    const cutoff = Date.now() - this.c.ttlMs;
    this.transaction(() => {
      this.expirePending();
      this.run(
        "UPDATE jobs SET status=CASE WHEN status='pending' THEN 'failed' ELSE status END,payload='{}',error=CASE WHEN status='pending' THEN '任务已过期' ELSE error END WHERE created<?",
        cutoff,
      );
      this.run(
        "UPDATE inbound SET payload='{}',context='' WHERE created<?",
        cutoff,
      );
      this.run("UPDATE events SET payload='{}' WHERE created<?", cutoff);
    });
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  close() {
    this.db.close();
  }
}
