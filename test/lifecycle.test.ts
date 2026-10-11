// Inbox lifecycle: heartbeat, concurrency, alarm expiry and the backup cron.

import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  listDurableObjectIds,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../worker/index";
import { INBOX_TTL_MS } from "../worker/lib/config";
import { runCleanup } from "../worker/scheduled";
import { DOMAIN, buildEmail, createInbox, deliver, forceExpire, api } from "./helpers";

const stub = (name: string) => env.INBOX.getByName(name);

async function tableCount(name: string): Promise<number> {
  return runInDurableObject(stub(name), (_i, state) =>
    state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`).one().n,
  );
}

describe("initialize", () => {
  it("creates metadata with a 24h expiry and an alarm", async () => {
    const before = Date.now();
    const info = await stub("init-one").initialize("init-one", DOMAIN);
    expect(info.address).toBe("init-one@mail.example.com");
    expect(info.expiresAt - info.lastPing).toBe(INBOX_TTL_MS);
    expect(info.lastPing).toBeGreaterThanOrEqual(before);
    const alarm = await runInDurableObject(stub("init-one"), (_i, s) => s.storage.getAlarm());
    expect(alarm).toBe(info.expiresAt);
  });

  it("is idempotent and does not reset an active inbox", async () => {
    const a = await stub("init-two").initialize("init-two", DOMAIN);
    const b = await stub("init-two").initialize("init-two", DOMAIN);
    expect(b.createdAt).toBe(a.createdAt);
  });

  it("tracks the inbox in the registry", async () => {
    await stub("init-three").initialize("init-three", DOMAIN);
    const { registryStub } = await import("../worker/registry");
    const due = await registryStub(env, "init-three").due(Date.now() + 2 * INBOX_TTL_MS, 1000);
    expect(due).toContain("init-three");
  });

  it("does not persist anything for unknown inboxes", async () => {
    const res = await stub("never-opened").heartbeat("never-opened", DOMAIN);
    expect(res).toEqual({ ok: false, reason: "not_found" });
    expect(await tableCount("never-opened")).toBe(0);
  });
});

describe("heartbeat", () => {
  it("updates lastPing and extends expiry to lastPing + 24h", async () => {
    const info = await stub("hb-one").initialize("hb-one", DOMAIN);
    await new Promise((r) => setTimeout(r, 5));
    const res = await stub("hb-one").heartbeat("hb-one", DOMAIN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.inbox.lastPing).toBeGreaterThanOrEqual(info.lastPing);
    expect(res.inbox.expiresAt).toBe(res.inbox.lastPing + INBOX_TTL_MS);
  });

  it("handles many concurrent heartbeats and emails without losing state", async () => {
    await stub("hb-concurrent").initialize("hb-concurrent", DOMAIN);
    const raw = buildEmail({ to: "hb-concurrent@mail.example.com" });
    const results = await Promise.all([
      ...Array.from({ length: 25 }, () => stub("hb-concurrent").heartbeat("hb-concurrent", DOMAIN)),
      ...Array.from({ length: 4 }, () => deliver("hb-concurrent@mail.example.com", raw)),
      ...Array.from({ length: 10 }, () => stub("hb-concurrent").cleanupExpired()),
    ]);
    const heartbeats = results.slice(0, 25) as Array<{ ok: boolean }>;
    expect(heartbeats.every((r) => r.ok)).toBe(true);
    const emails = results.slice(25, 29) as Array<{ rejected: string | null }>;
    expect(emails.every((m) => m.rejected === null)).toBe(true);
    const cleanups = results.slice(29) as Array<{ status: string }>;
    expect(cleanups.every((c) => c.status === "active")).toBe(true);

    const list = await stub("hb-concurrent").listEmails("hb-concurrent", DOMAIN);
    expect(list.ok && list.messages.length).toBe(4);
    expect(list.ok && list.inbox.messageCount).toBe(4);
  });

  it("never revives an expired inbox", async () => {
    await stub("hb-expired").initialize("hb-expired", DOMAIN);
    await forceExpire("hb-expired");
    expect(await stub("hb-expired").heartbeat("hb-expired", DOMAIN)).toEqual({ ok: false, reason: "expired" });
    // Purged: a second heartbeat sees nothing at all.
    expect(await stub("hb-expired").heartbeat("hb-expired", DOMAIN)).toEqual({ ok: false, reason: "not_found" });
  });

  it("a heartbeat processed before the alarm keeps the inbox alive", async () => {
    await stub("hb-race").initialize("hb-race", DOMAIN);
    await forceExpire("hb-race");
    // Simulate "heartbeat landed just before expiry" by restoring a future expiry, then
    // fire the alarm that was scheduled for the old time.
    await runInDurableObject(stub("hb-race"), (_i, s) => {
      s.storage.sql.exec(`UPDATE meta SET expires_at = ? WHERE id = 1`, Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(stub("hb-race"))).toBe(true);
    const res = await stub("hb-race").getInbox("hb-race", DOMAIN);
    expect(res.ok).toBe(true);
    // The alarm rescheduled itself to the new expiry.
    const alarm = await runInDurableObject(stub("hb-race"), (_i, s) => s.storage.getAlarm());
    expect(alarm).toBe(res.ok ? res.inbox.expiresAt : -1);
  });
});

describe("expiry", () => {
  it("the alarm deletes all messages and metadata", async () => {
    await stub("exp-alarm").initialize("exp-alarm", DOMAIN);
    const msg = await deliver("exp-alarm@mail.example.com", buildEmail({ to: "exp-alarm@mail.example.com" }));
    expect(msg.rejected).toBeNull();
    await forceExpire("exp-alarm");

    expect(await runDurableObjectAlarm(stub("exp-alarm"))).toBe(true);
    expect(await tableCount("exp-alarm")).toBe(0);
    const alarm = await runInDurableObject(stub("exp-alarm"), (_i, s) => s.storage.getAlarm());
    expect(alarm).toBeNull();
    expect(await stub("exp-alarm").listEmails("exp-alarm", DOMAIN)).toEqual({ ok: false, reason: "not_found" });
  });

  it("expired data is never served even before the alarm runs", async () => {
    await stub("exp-lazy").initialize("exp-lazy", DOMAIN);
    await deliver("exp-lazy@mail.example.com", buildEmail({ to: "exp-lazy@mail.example.com" }));
    await forceExpire("exp-lazy");
    const res = await api("/api/inboxes/exp-lazy/messages");
    expect(res.status).toBe(410);
    expect(await tableCount("exp-lazy")).toBe(0);
  });

  it("incoming mail does not extend or revive an expired inbox", async () => {
    await stub("exp-mail").initialize("exp-mail", DOMAIN);
    await forceExpire("exp-mail");
    const msg = await deliver("exp-mail@mail.example.com", buildEmail({ to: "exp-mail@mail.example.com" }));
    expect(msg.rejected).toBe("Mailbox does not exist");
    expect(await tableCount("exp-mail")).toBe(0);
  });

  it("incoming mail does not change expiresAt on an active inbox", async () => {
    const info = await stub("exp-noextend").initialize("exp-noextend", DOMAIN);
    await deliver("exp-noextend@mail.example.com", buildEmail({ to: "exp-noextend@mail.example.com" }));
    const after = await stub("exp-noextend").getInbox("exp-noextend", DOMAIN);
    expect(after.ok && after.inbox.expiresAt).toBe(info.expiresAt);
  });

  it("re-opening an expired address starts a fresh, empty inbox", async () => {
    await stub("exp-reopen").initialize("exp-reopen", DOMAIN);
    await deliver("exp-reopen@mail.example.com", buildEmail({ to: "exp-reopen@mail.example.com" }));
    await forceExpire("exp-reopen");
    const { res, body } = await createInbox("exp-reopen");
    expect(res.status).toBe(200);
    expect(body.inbox.messageCount).toBe(0);
  });
});

describe("backup cron", () => {
  it("purges expired inboxes whose alarm did not run and keeps active ones", async () => {
    await stub("cron-expired").initialize("cron-expired", DOMAIN);
    await stub("cron-active").initialize("cron-active", DOMAIN);
    await deliver("cron-expired@mail.example.com", buildEmail({ to: "cron-expired@mail.example.com" }));
    await forceExpire("cron-expired");
    // Simulate a lost alarm.
    await runInDurableObject(stub("cron-expired"), (_i, s) => s.storage.deleteAlarm());

    // The registry hint says both are due when "now" is far in the future.
    const stats = await runCleanup(env, Date.now() + 2 * INBOX_TTL_MS);
    expect(stats.failed).toBe(0);
    expect(stats.expired).toBeGreaterThanOrEqual(1);

    expect(await tableCount("cron-expired")).toBe(0);
    expect((await stub("cron-active").getInbox("cron-active", DOMAIN)).ok).toBe(true);
  });

  it("runs through the scheduled() handler", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: new Date(), cron: "17 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await listDurableObjectIds(env.REGISTRY)).length).toBeGreaterThan(0);
  });
});
