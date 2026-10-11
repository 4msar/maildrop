// Manual admin cleanup route. Routing is not configured in tests (no real API calls), so
// this covers auth, dry runs, batching and inbox wiping; rule listing is tested below with
// an in-memory fake of the Cloudflare API.

import { describe, expect, it } from "vitest";
import { listDomainRules, type RoutingConfig } from "../worker/lib/routing";
import { api, buildEmail, createInbox, deliver } from "./helpers";

const cleanup = (query = "", token: string | null = "test-admin-token") =>
  api(`/api/admin/cleanup${query}`, {
    method: "POST",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

describe("admin cleanup", () => {
  it("requires the admin token", async () => {
    expect((await cleanup("", null)).status).toBe(401);
    expect((await cleanup("", "wrong")).status).toBe(401);
    expect((await api("/api/admin/cleanup")).status).toBe(404); // GET is not a route
  });

  it("validates limit", async () => {
    expect((await cleanup("?limit=0")).status).toBe(400);
    expect((await cleanup("?limit=abc")).status).toBe(400);
    expect((await cleanup("?limit=501")).status).toBe(400);
  });

  it("dry run lists inboxes without deleting them, then cleanup wipes them in batches", async () => {
    for (const u of ["wipe-a", "wipe-b", "wipe-c"]) await createInbox(u);
    await deliver("wipe-a@maildrop.msar.me", buildEmail({ to: "wipe-a@maildrop.msar.me" }));

    const dry = (await (await cleanup("?dry_run=1")).json()) as any;
    expect(dry).toMatchObject({ dryRun: true, routingConfigured: false, done: true });
    expect(dry.inboxes.usernames).toEqual(["wipe-a", "wipe-b", "wipe-c"]);
    expect(dry.inboxes.deleted).toBe(0);
    expect((await api("/api/inboxes/wipe-a/messages")).status).toBe(200);

    const first = (await (await cleanup("?limit=2")).json()) as any;
    expect(first.inboxes).toMatchObject({ found: 3, deleted: 2, failed: 0 });
    expect(first.done).toBe(false);

    const second = (await (await cleanup("?limit=2")).json()) as any;
    expect(second.inboxes).toMatchObject({ found: 1, deleted: 1 });
    expect(second.done).toBe(true);

    for (const u of ["wipe-a", "wipe-b", "wipe-c"]) {
      expect((await api(`/api/inboxes/${u}/messages`)).status).toBe(404);
    }
    expect((await deliver("wipe-a@maildrop.msar.me", buildEmail({ to: "wipe-a@maildrop.msar.me" }))).rejected).not.toBeNull();

    const empty = (await (await cleanup()).json()) as any;
    expect(empty).toMatchObject({ done: true, inboxes: { found: 0 } });
  });
});

describe("listDomainRules", () => {
  it("returns literal rules for the domain only", async () => {
    const cfg: RoutingConfig = { zoneId: "z", token: "t", workerName: "maildrop" };
    const rule = (id: string, type: string, value?: string) => ({
      id,
      enabled: true,
      matchers: [{ type, field: "to", ...(value ? { value } : {}) }],
    });
    const result = [
      rule("1", "literal", "Hello@Maildrop.msar.me"),
      rule("2", "literal", "someone@msar.me"),
      rule("3", "literal", "x@notmaildrop.msar.me"),
      rule("4", "all"),
      rule("5", "literal", "postmaster@maildrop.msar.me"),
    ];
    const fetcher = (async () =>
      Response.json({ success: true, result, result_info: { page: 1, per_page: 50, total_count: result.length } })) as unknown as typeof fetch;
    expect(await listDomainRules(cfg, "maildrop.msar.me", fetcher)).toEqual([
      { id: "1", enabled: true, address: "hello@maildrop.msar.me" },
      { id: "5", enabled: true, address: "postmaster@maildrop.msar.me" },
    ]);
  });
});
