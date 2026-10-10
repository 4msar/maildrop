// Backup cleanup. Each inbox schedules its own Durable Object alarm, which is the
// primary expiry mechanism. This cron sweep catches anything an alarm missed, e.g. an
// inbox whose alarm was lost to a bug or whose alarm retries were exhausted.

import { CRON_BATCH_PER_SHARD, REGISTRY_SHARDS } from "./lib/config";
import { errorFields, log } from "./lib/log";

const CONCURRENCY = 10;

export async function runCleanup(env: Env, now = Date.now()): Promise<{ checked: number; expired: number; failed: number }> {
  const stats = { checked: 0, expired: 0, failed: 0 };

  for (let shard = 0; shard < REGISTRY_SHARDS; shard++) {
    const registry = env.REGISTRY.getByName(`shard-${shard}`);
    let due: string[];
    try {
      due = await registry.due(now, CRON_BATCH_PER_SHARD);
    } catch (err) {
      stats.failed++;
      log("error", "cron.registry_failed", { shard, ...errorFields(err) });
      continue;
    }

    for (let i = 0; i < due.length; i += CONCURRENCY) {
      await Promise.all(
        due.slice(i, i + CONCURRENCY).map(async (username) => {
          stats.checked++;
          try {
            const res = await env.INBOX.getByName(username).cleanupExpired();
            if (res.status === "active" && res.expiresAt) {
              await registry.track(username, res.expiresAt);
            } else {
              if (res.status === "expired") stats.expired++;
              // The inbox untracks itself on purge; this covers "missing" and failed untracks.
              await registry.untrack(username);
            }
          } catch (err) {
            stats.failed++;
            log("error", "cron.inbox_failed", errorFields(err));
          }
        }),
      );
    }
  }

  log("info", "cron.cleanup", stats);
  return stats;
}
