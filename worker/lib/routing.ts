// Per-address Email Routing rules, managed through the Cloudflare API.
//
// Only active when both ZONE_ID and CF_TOKEN are set (CF_TOKEN needs the
// "Zone > Email Routing Rules > Edit" permission). Without them inboxes are opened as before
// and mail relies on a catch-all rule configured in the dashboard.

import type { RoutingStatus } from "../../shared/api-types";

const API_BASE = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 50;
/** Email Routing allows at most 200 rules per zone. */
const MAX_PAGES = 4;

export interface RoutingConfig {
    zoneId: string;
    token: string;
    workerName: string;
}

export interface RoutingRule {
    id: string;
    enabled: boolean;
}

interface ApiRule {
    id?: string;
    tag?: string;
    enabled?: boolean;
    matchers?: Array<{ type?: string; field?: string; value?: string }>;
}

interface ApiEnvelope<T> {
    success: boolean;
    result: T;
    errors?: Array<{ code: number; message: string }>;
    result_info?: {
        page: number;
        per_page: number;
        total_count?: number;
        count?: number;
    };
}

type Fetcher = typeof fetch;

export class RoutingApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "RoutingApiError";
        this.status = status;
    }
}

export function getRoutingConfig(env: Env): RoutingConfig | null {
    const zoneId = env.ZONE_ID?.trim();
    const token = env.CF_TOKEN?.trim();
    if (!zoneId || !token) return null;
    return {
        zoneId,
        token,
        workerName: env.EMAIL_WORKER_NAME?.trim() || "maildrop",
    };
}

export function statusOf(rule: RoutingRule | null): RoutingStatus {
    if (!rule) return "not_configured";
    return rule.enabled ? "enabled" : "disabled";
}

async function call<T>(
    cfg: RoutingConfig,
    path: string,
    init: RequestInit = {},
    fetcher: Fetcher = fetch,
): Promise<ApiEnvelope<T>> {
    const res = await fetcher(
        `${API_BASE}/zones/${encodeURIComponent(cfg.zoneId)}/email/routing${path}`,
        {
            ...init,
            headers: {
                Authorization: `Bearer ${cfg.token}`,
                "Content-Type": "application/json",
                ...init.headers,
            },
        },
    );
    let body: ApiEnvelope<T> | null = null;
    try {
        body = (await res.json()) as ApiEnvelope<T>;
    } catch {
        // Non-JSON error page.
    }
    if (!res.ok || !body?.success) {
        const detail =
            body?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ||
            `HTTP ${res.status}`;
        throw new RoutingApiError(
            res.status,
            `Email Routing API failed (${detail})`,
        );
    }
    return body;
}

function toRule(r: ApiRule): RoutingRule | null {
    const id = r.id ?? r.tag;
    return id ? { id, enabled: r.enabled === true } : null;
}

function matchesAddress(r: ApiRule, address: string): boolean {
    return (r.matchers ?? []).some(
        (m) =>
            m.type === "literal" &&
            m.field === "to" &&
            m.value?.toLowerCase() === address,
    );
}

/** Returns the rule, or null when it no longer exists. */
export async function getRule(
    cfg: RoutingConfig,
    id: string,
    fetcher?: Fetcher,
): Promise<RoutingRule | null> {
    try {
        const { result } = await call<ApiRule>(
            cfg,
            `/rules/${encodeURIComponent(id)}`,
            {},
            fetcher,
        );
        return toRule(result);
    } catch (err) {
        if (err instanceof RoutingApiError && err.status === 404) return null;
        throw err;
    }
}

/** Yields every rule in the zone, one API page at a time. */
async function* listRules(
    cfg: RoutingConfig,
    fetcher?: Fetcher,
): AsyncGenerator<ApiRule> {
    for (let page = 1; page <= MAX_PAGES; page++) {
        const { result, result_info } = await call<ApiRule[]>(
            cfg,
            `/rules?page=${page}&per_page=${PAGE_SIZE}`,
            {},
            fetcher,
        );
        yield* result;
        const total = result_info?.total_count;
        if (
            result.length < PAGE_SIZE ||
            (total !== undefined && page * PAGE_SIZE >= total)
        )
            break;
    }
}

/** Finds an existing literal rule for this address (e.g. left behind by a failed cleanup). */
export async function findRule(
    cfg: RoutingConfig,
    address: string,
    fetcher?: Fetcher,
): Promise<RoutingRule | null> {
    for await (const r of listRules(cfg, fetcher)) {
        if (matchesAddress(r, address)) return toRule(r);
    }
    return null;
}

/** Every rule with a literal "to" matcher for an address at `domain` (the catch-all is excluded). */
export async function listDomainRules(
    cfg: RoutingConfig,
    domain: string,
    fetcher?: Fetcher,
): Promise<Array<RoutingRule & { address: string }>> {
    const suffix = `@${domain.toLowerCase()}`;
    const out: Array<RoutingRule & { address: string }> = [];
    for await (const r of listRules(cfg, fetcher)) {
        const rule = toRule(r);
        const address = (r.matchers ?? [])
            .find(
                (m) =>
                    m.type === "literal" &&
                    m.field === "to" &&
                    m.value?.toLowerCase().endsWith(suffix),
            )
            ?.value?.toLowerCase();
        if (rule && address) out.push({ ...rule, address });
    }
    return out;
}

/** Returns the rule that sends `address` to the Worker, creating it when missing. */
export async function ensureRule(
    cfg: RoutingConfig,
    address: string,
    fetcher?: Fetcher,
): Promise<RoutingRule> {
    const existing = await findRule(cfg, address, fetcher);
    if (existing) return existing;
    const { result } = await call<ApiRule>(
        cfg,
        "/rules",
        {
            method: "POST",
            body: JSON.stringify({
                name: `maildrop: ${address}`,
                enabled: true,
                matchers: [{ type: "literal", field: "to", value: address }],
                actions: [{ type: "worker", value: [cfg.workerName] }],
            }),
        },
        fetcher,
    );
    const rule = toRule(result);
    if (!rule)
        throw new RoutingApiError(
            500,
            "Email Routing API returned a rule without an id",
        );
    return rule;
}

export async function deleteRule(
    cfg: RoutingConfig,
    id: string,
    fetcher?: Fetcher,
): Promise<void> {
    try {
        await call(
            cfg,
            `/rules/${encodeURIComponent(id)}`,
            { method: "DELETE" },
            fetcher,
        );
    } catch (err) {
        if (err instanceof RoutingApiError && err.status === 404) return;
        throw err;
    }
}
