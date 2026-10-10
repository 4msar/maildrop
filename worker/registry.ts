// InboxRegistry: a small sharded index of inbox names used only by the backup cron sweep.
// Each inbox Durable Object is the source of truth for its own expiry. The registry
// stores a "check after" hint so the cron only visits inboxes that might be expired.

import { DurableObject } from "cloudflare:workers";
import { REGISTRY_SHARDS } from "./lib/config";

export function registryShardFor(username: string): string {
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < username.length; i++) {
    h ^= username.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `shard-${(h >>> 0) % REGISTRY_SHARDS}`;
}

export function registryStub(env: Env, username: string) {
  return env.REGISTRY.getByName(registryShardFor(username));
}

export class InboxRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS inboxes (
        username TEXT PRIMARY KEY,
        check_after INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inboxes_check_after ON inboxes(check_after);
    `);
  }

  track(username: string, checkAfter: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO inboxes (username, check_after) VALUES (?, ?)
       ON CONFLICT(username) DO UPDATE SET check_after = excluded.check_after`,
      username,
      checkAfter,
    );
  }

  untrack(username: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM inboxes WHERE username = ?`, username);
  }

  due(now: number, limit: number): string[] {
    return this.ctx.storage.sql
      .exec<{ username: string }>(
        `SELECT username FROM inboxes WHERE check_after <= ? ORDER BY check_after LIMIT ?`,
        now,
        limit,
      )
      .toArray()
      .map((r) => r.username);
  }

  count(): number {
    return this.ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM inboxes`).one().n;
  }
}
