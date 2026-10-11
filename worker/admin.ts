// Manually triggered cleanup (POST /api/admin/cleanup). Deletes every literal Email Routing
// rule for an inbox address at the mail domain and every inbox: those in the registry and those
// named by a rule. Rules for reserved names (postmaster@, abuse@, ...) are never touched.
//
// Work is done in batches of `limit` so one request stays under the Workers subrequest
// limit; the response says whether anything is left, so call it again until `done` is true.

import { REGISTRY_SHARDS } from "./lib/config";
import { errorFields, log } from "./lib/log";
import { deleteRule, getRoutingConfig, listDomainRules } from "./lib/routing";
import { registryShardFor } from "./registry";
import { checkUsername } from "../shared/username";

const CONCURRENCY = 10;
/** Upper bound on registry entries read per shard; plenty for one batch. */
const REGISTRY_PAGE = 1000;

export interface CleanupReport {
  dryRun: boolean;
  /** False when ZONE_ID / CF_TOKEN are unset, so rules were not looked at. */
  routingConfigured: boolean;
  rules: { found: number; deleted: number; failed: number; skipped: string[]; addresses: string[] };
  inboxes: { found: number; deleted: number; failed: number; usernames: string[] };
  done: boolean;
}

async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
  }
}

export async function runAdminCleanup(env: Env, opts: { dryRun: boolean; limit: number; domain: string }): Promise<CleanupReport> {
  const { domain } = opts;
  const cfg = getRoutingConfig(env);

  // Rules: only literal addresses whose local part is a valid, non-reserved inbox name.
  const rules: Array<{ id: string; address: string; username: string }> = [];
  const skipped: string[] = [];
  if (cfg) {
    for (const rule of await listDomainRules(cfg, domain)) {
      const check = checkUsername(rule.address.slice(0, rule.address.lastIndexOf("@")));
      if (check.ok) rules.push({ id: rule.id, address: rule.address, username: check.username });
      else skipped.push(rule.address);
    }
  }

  // Inboxes: everything the registry tracks, plus inboxes named by a rule.
  const usernames = new Set(rules.map((r) => r.username));
  for (let shard = 0; shard < REGISTRY_SHARDS; shard++) {
    for (const u of await env.REGISTRY.getByName(`shard-${shard}`).list("", REGISTRY_PAGE)) usernames.add(u);
  }
  const allInboxes = [...usernames].sort();

  const ruleBatch = rules.slice(0, opts.limit);
  const inboxBatch = allInboxes.slice(0, opts.limit);
  const report: CleanupReport = {
    dryRun: opts.dryRun,
    routingConfigured: cfg !== null,
    rules: { found: rules.length, deleted: 0, failed: 0, skipped, addresses: ruleBatch.map((r) => r.address) },
    inboxes: { found: allInboxes.length, deleted: 0, failed: 0, usernames: inboxBatch },
    done: rules.length <= opts.limit && allInboxes.length <= opts.limit,
  };
  if (opts.dryRun) return report;

  // Rules first, so no new mail is routed to an inbox while it is being wiped.
  await inBatches(ruleBatch, async (rule) => {
    try {
      await deleteRule(cfg!, rule.id);
      report.rules.deleted++;
    } catch (err) {
      report.rules.failed++;
      log("error", "admin.rule_delete_failed", errorFields(err));
    }
  });

  await inBatches(inboxBatch, async (username) => {
    try {
      await env.INBOX.getByName(username).wipe();
      // purge() untracks existing inboxes; this also drops entries for missing ones.
      await env.REGISTRY.getByName(registryShardFor(username)).untrack(username);
      report.inboxes.deleted++;
    } catch (err) {
      report.inboxes.failed++;
      log("error", "admin.inbox_wipe_failed", errorFields(err));
    }
  });

  report.done = report.done && report.rules.failed === 0 && report.inboxes.failed === 0;
  log("info", "admin.cleanup", {
    rulesDeleted: report.rules.deleted,
    rulesFailed: report.rules.failed,
    inboxesDeleted: report.inboxes.deleted,
    inboxesFailed: report.inboxes.failed,
    done: report.done,
  });
  return report;
}
