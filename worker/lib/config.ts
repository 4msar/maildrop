// Limits and lifecycle constants. Size limits can be overridden with Wrangler `vars`.

export const HOUR_MS = 60 * 60 * 1000;

/** An inbox lives this long after its most recent heartbeat. */
export const INBOX_TTL_MS = 24 * HOUR_MS;

/** The client sends a heartbeat this often while the inbox page is open. */
export const HEARTBEAT_INTERVAL_MS = HOUR_MS;

/** Raw MIME is split into chunks so each SQLite row stays below the 2 MB row limit. */
export const RAW_CHUNK_BYTES = 1024 * 1024;

/** Parsed text/HTML bodies are truncated to this many UTF-8 bytes (one row each). */
export const MAX_BODY_BYTES = 1_500_000;

/** Upper bound for the serialized header list kept per message. */
export const MAX_HEADERS_JSON_BYTES = 64 * 1024;

/** Inbound per-inbox rate limit, enforced inside the Durable Object. */
export const INBOUND_RATE_WINDOW_MS = 10 * 60 * 1000;
export const INBOUND_RATE_MAX = 30;

/** Number of registry shards that track inboxes for the backup cron sweep. */
export const REGISTRY_SHARDS = 8;

/** Inboxes checked per shard per cron run. */
export const CRON_BATCH_PER_SHARD = 100;

export interface Limits {
    maxMessageBytes: number;
    maxInboxBytes: number;
    maxMessagesPerInbox: number;
}

function intVar(value: string | undefined, fallback: number): number {
    const n = Number.parseInt(value ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getLimits(env: Env): Limits {
    return {
        // Email Routing rejects anything over 25 MiB before it reaches the Worker.
        maxMessageBytes: Math.min(
            intVar(env.MAX_MESSAGE_BYTES, 10 * 1024 * 1024),
            25 * 1024 * 1024,
        ),
        maxInboxBytes: intVar(env.MAX_INBOX_BYTES, 50 * 1024 * 1024),
        maxMessagesPerInbox: intVar(env.MAX_MESSAGES_PER_INBOX, 100),
    };
}

/**
 * Public origin of the site: SITE_URL when set (e.g. "https://mail.example.com"), otherwise
 * `requestOrigin`. Used for canonical/Open Graph URLs.
 */
export function siteOrigin(env: Env, requestOrigin: string): string {
    const configured = env.SITE_URL?.trim();
    if (configured) {
        try {
            return new URL(configured).origin;
        } catch {
            // Invalid SITE_URL: fall back to the request.
        }
    }
    return requestOrigin;
}

/**
 * Domain that inboxes receive mail at: MAIL_DOMAIN, else the host of SITE_URL, else
 * `fallbackHost` (the request's host, or the recipient's domain for inbound mail).
 */
export function mailDomain(env: Env, fallbackHost: string): string {
    const configured = env.MAIL_DOMAIN?.trim();
    if (configured) return configured.toLowerCase();
    return new URL(
        siteOrigin(env, `https://${fallbackHost}`),
    ).hostname.toLowerCase();
}

export type OrphanedEmailAction = "reject" | "forward" | "drop";

/** What to do with mail addressed to a domain other than the mail domain. Defaults to "reject". */
export function orphanedEmailAction(env: Env): OrphanedEmailAction {
    const action = env.ORPHANED_EMAIL_ACTION?.trim().toLowerCase();
    if (action === "reject" || action === "forward" || action === "drop") {
        return action;
    }
    return "reject";
}

/** Verified Email Routing destination addresses that orphaned mail is forwarded to. */
export function forwardAddresses(env: Env): string[] {
    return (env.FORWARD_TO ?? "")
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean);
}
