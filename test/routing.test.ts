// Email Routing rule management. The Cloudflare API is replaced by an in-memory fake.

import { describe, expect, it } from "vitest";
import { deleteRule, ensureRule, findRule, getRoutingConfig, getRule, statusOf, type RoutingConfig } from "../worker/lib/routing";
import { api, createInbox } from "./helpers";

const cfg: RoutingConfig = { zoneId: "zone123", token: "tok", workerName: "maildrop" };

interface FakeRule {
  id: string;
  enabled: boolean;
  matchers: Array<{ type: string; field: string; value: string }>;
  actions: Array<{ type: string; value: string[] }>;
}

function fakeApi(initial: FakeRule[] = []) {
  const rules = [...initial];
  const calls: Array<{ method: string; url: string; auth: string | null; body?: any }> = [];
  const ok = (result: unknown, extra: object = {}) => Response.json({ success: true, errors: [], result, ...extra });
  const notFound = () => Response.json({ success: false, errors: [{ code: 1000, message: "not found" }], result: null }, { status: 404 });

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: url.pathname + url.search, auth: new Headers(init?.headers).get("authorization"), body });
    const base = "/client/v4/zones/zone123/email/routing/rules";
    if (url.pathname === base && method === "GET") {
      const page = Number(url.searchParams.get("page"));
      const per = Number(url.searchParams.get("per_page"));
      return ok(rules.slice((page - 1) * per, page * per), { result_info: { page, per_page: per, total_count: rules.length } });
    }
    if (url.pathname === base && method === "POST") {
      const rule = { id: `r${rules.length + 1}`, ...body };
      rules.push(rule);
      return ok(rule);
    }
    const id = url.pathname.slice(base.length + 1);
    const idx = rules.findIndex((r) => r.id === id);
    if (idx < 0) return notFound();
    if (method === "DELETE") return ok(rules.splice(idx, 1)[0]);
    return ok(rules[idx]);
  }) as typeof fetch;

  return { rules, calls, fetcher };
}

const literal = (id: string, address: string, enabled = true): FakeRule => ({
  id,
  enabled,
  matchers: [{ type: "literal", field: "to", value: address }],
  actions: [{ type: "worker", value: ["maildrop"] }],
});

describe("routing config", () => {
  it("is only enabled when both ZONE_ID and CF_TOKEN are set", () => {
    expect(getRoutingConfig({} as Env)).toBeNull();
    expect(getRoutingConfig({ ZONE_ID: "z" } as Env)).toBeNull();
    expect(getRoutingConfig({ CF_TOKEN: "t" } as Env)).toBeNull();
    expect(getRoutingConfig({ ZONE_ID: " z ", CF_TOKEN: "t" } as Env)).toEqual({ zoneId: "z", token: "t", workerName: "maildrop" });
  });

  it("maps rules to badge states", () => {
    expect(statusOf(null)).toBe("not_configured");
    expect(statusOf({ id: "a", enabled: true })).toBe("enabled");
    expect(statusOf({ id: "a", enabled: false })).toBe("disabled");
  });
});

describe("routing rules", () => {
  it("creates a literal rule that sends the address to the Worker", async () => {
    const fake = fakeApi();
    const rule = await ensureRule(cfg, "hello@mail.example.com", fake.fetcher);
    expect(rule).toEqual({ id: "r1", enabled: true });
    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.auth).toBe("Bearer tok");
    expect(post.body).toMatchObject({
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: "hello@mail.example.com" }],
      actions: [{ type: "worker", value: ["maildrop"] }],
    });
  });

  it("reuses an existing rule for the same address instead of creating another", async () => {
    const others = Array.from({ length: 60 }, (_, i) => literal(`o${i}`, `other${i}@mail.example.com`));
    const fake = fakeApi([...others, literal("mine", "hello@mail.example.com", false)]);
    expect(await ensureRule(cfg, "hello@mail.example.com", fake.fetcher)).toEqual({ id: "mine", enabled: false });
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(2); // paginated past the first 50
  });

  it("reads, finds and deletes rules; missing rules are not errors", async () => {
    const fake = fakeApi([literal("a", "x@mail.example.com")]);
    expect(await getRule(cfg, "a", fake.fetcher)).toEqual({ id: "a", enabled: true });
    expect(await findRule(cfg, "nobody@mail.example.com", fake.fetcher)).toBeNull();
    await deleteRule(cfg, "a", fake.fetcher);
    expect(fake.rules).toHaveLength(0);
    expect(await getRule(cfg, "a", fake.fetcher)).toBeNull();
    await expect(deleteRule(cfg, "a", fake.fetcher)).resolves.toBeUndefined();
  });

  it("surfaces API failures", async () => {
    const fetcher = (async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 })) as unknown as typeof fetch;
    await expect(ensureRule(cfg, "a@mail.example.com", fetcher)).rejects.toThrow(/Authentication error/);
  });
});

describe("routing without ZONE_ID / CF_TOKEN", () => {
  it("just opens the inbox and reports not_configured", async () => {
    const { res, body } = await createInbox("routing-off");
    expect(res.status).toBe(200);
    expect(body.routing).toBe("not_configured");
    const status = await api("/api/inboxes/routing-off/routing");
    expect(await status.json()).toEqual({ routing: "not_configured" });
  });

  it("returns 404 for the routing status of an unknown inbox", async () => {
    expect((await api("/api/inboxes/never-opened-x/routing")).status).toBe(404);
  });
});
