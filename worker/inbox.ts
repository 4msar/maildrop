// InboxDurableObject: one instance per inbox username (addressed with getByName(username)).
// All metadata and messages live in this object's SQLite storage.
//
// Concurrency model
// - A Durable Object processes events one at a time, and every SQL call below is
//   synchronous, so each method's reads and writes run without interleaving.
// - Multi-row writes use transactionSync, so a failure never leaves partial messages.
// - Expiry is decided and executed inside blockConcurrencyWhile after re-reading
//   lastPing, so a heartbeat that landed first always wins and cannot be lost.
// - Only heartbeat() and initialize() extend expiresAt. Incoming mail never does.

import { DurableObject } from "cloudflare:workers";
import type {
    InboxInfo,
    MessageDetail,
    MessageSummary,
    AttachmentInfo,
    RoutingStatus,
} from "../shared/api-types";
import {
    INBOUND_RATE_MAX,
    INBOUND_RATE_WINDOW_MS,
    INBOX_TTL_MS,
    RAW_CHUNK_BYTES,
    getLimits,
} from "./lib/config";
import { newMessageId } from "./lib/ids";
import { errorFields, log } from "./lib/log";
import type { ParsedEmail } from "./lib/mime";
import {
    deleteRule,
    ensureRule,
    getRoutingConfig,
    getRule,
    statusOf,
} from "./lib/routing";
import { registryStub } from "./registry";

export type InboxFailure =
    | "not_found"
    | "expired"
    | "mailbox_full"
    | "rate_limited"
    | "too_large"
    | "storage_error";
export type Result<T> =
    | ({ ok: true } & T)
    | { ok: false; reason: InboxFailure };

export interface ReceiveEmailInput {
    username: string;
    raw: Uint8Array;
    parsed: ParsedEmail;
    envelopeFrom: string;
    envelopeTo: string;
}

interface MetaRow {
    username: string;
    created_at: number;
    last_ping: number;
    expires_at: number;
    message_count: number;
    total_bytes: number;
    rate_window_start: number;
    rate_count: number;
    [key: string]: SqlStorageValue;
}

interface MessageRow {
    id: string;
    received_at: number;
    envelope_from: string;
    from_addr: string;
    to_addr: string;
    cc: string;
    reply_to: string;
    subject: string;
    date_header: string | null;
    message_id_header: string | null;
    preview: string;
    size: number;
    chunk_count: number;
    attachment_count: number;
    attachments_json: string;
    headers_json: string;
    text_truncated: number;
    html_truncated: number;
    malformed: number;
    [key: string]: SqlStorageValue;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_ping INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    rate_window_start INTEGER NOT NULL DEFAULT 0,
    rate_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL,
    envelope_from TEXT NOT NULL,
    envelope_to TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    cc TEXT NOT NULL,
    reply_to TEXT NOT NULL,
    subject TEXT NOT NULL,
    date_header TEXT,
    message_id_header TEXT,
    preview TEXT NOT NULL,
    size INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    attachment_count INTEGER NOT NULL,
    attachments_json TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    text_truncated INTEGER NOT NULL,
    html_truncated INTEGER NOT NULL,
    malformed INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_received_at ON messages(received_at);
  CREATE TABLE IF NOT EXISTS bodies (
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'html')),
    content TEXT NOT NULL,
    PRIMARY KEY (message_id, kind)
  );
  CREATE TABLE IF NOT EXISTS raw_chunks (
    message_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (message_id, seq)
  );
`;

/** KV key (cleared by deleteAll) holding this inbox's Email Routing rule id. */
const ROUTING_RULE_KEY = "routingRuleId";

const MESSAGE_SUMMARY_COLUMNS =
    "id, received_at, from_addr, subject, preview, size, attachment_count, envelope_from";

export class InboxDurableObject extends DurableObject<Env> {
    private sql: SqlStorage;
    private schemaReady: boolean;
    /** Shared by concurrent ensureRouting() calls, so they never create duplicate rules. */
    private routingInFlight: Promise<RoutingStatus> | null = null;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        // Tables are created lazily in initialize(), so that mail to a never-opened address
        // (or any other probe) does not leave empty storage behind.
        this.schemaReady =
            this.sql
                .exec(
                    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`,
                )
                .toArray().length > 0;
    }

    // ---------------------------------------------------------------- lifecycle

    /** Opens an inbox, creating its metadata when it does not exist (or has expired). */
    async initialize(username: string, domain: string): Promise<InboxInfo> {
        await this.expireIfDue();
        const existing = this.readMeta();
        if (existing && existing.username === username)
            return this.toInfo(existing, domain);

        const now = Date.now();
        const expiresAt = now + INBOX_TTL_MS;
        this.ensureSchema();
        this.sql.exec(
            `INSERT INTO meta (id, username, created_at, last_ping, expires_at) VALUES (1, ?, ?, ?, ?)`,
            username,
            now,
            now,
            expiresAt,
        );
        await this.ctx.storage.setAlarm(expiresAt);
        log("info", "inbox.created", {
            shard: this.ctx.id.toString().slice(0, 12),
        });

        try {
            await registryStub(this.env, username).track(username, expiresAt);
        } catch (err) {
            // The alarm is the primary cleanup path; the registry is only a backup index.
            log("warn", "registry.track_failed", errorFields(err));
        }
        return this.toInfo(this.readMeta()!, domain);
    }

    /** Records a heartbeat: lastPing = now, expiresAt = now + 24h. Never revives an expired inbox. */
    async heartbeat(username: string, domain: string): Promise<Result<{ inbox: InboxInfo }>> {
        if (await this.expireIfDue()) return { ok: false, reason: "expired" };
        const meta = this.readMeta();
        if (!meta || meta.username !== username)
            return { ok: false, reason: "not_found" };

        const now = Date.now();
        // max() keeps expiresAt monotonic even if clocks or retries deliver an older ping.
        const lastPing = Math.max(meta.last_ping, now);
        const expiresAt = lastPing + INBOX_TTL_MS;
        this.sql.exec(
            `UPDATE meta SET last_ping = ?, expires_at = ? WHERE id = 1`,
            lastPing,
            expiresAt,
        );

        // The alarm is moved forward lazily by alarm() itself; only repair it if missing.
        if ((await this.ctx.storage.getAlarm()) === null) {
            await this.ctx.storage.setAlarm(expiresAt);
        }
        return { ok: true, inbox: this.toInfo(this.readMeta()!, domain) };
    }

    /** Alarm handler. Durable: alarms are persisted and retried by the platform. */
    async alarm(): Promise<void> {
        const meta = this.readMeta();
        if (!meta) return;
        if (Date.now() >= meta.expires_at) {
            await this.purge("alarm");
        } else {
            // A heartbeat extended the inbox after this alarm was scheduled.
            await this.ctx.storage.setAlarm(meta.expires_at);
        }
    }

    /** Called by the backup cron. Returns the authoritative state for the registry. */
    async cleanupExpired(): Promise<{
        status: "missing" | "expired" | "active";
        expiresAt?: number;
    }> {
        const meta = this.readMeta();
        if (!meta) return { status: "missing" };
        if (await this.expireIfDue("cron")) return { status: "expired" };
        if ((await this.ctx.storage.getAlarm()) === null) {
            await this.ctx.storage.setAlarm(meta.expires_at);
        }
        return { status: "active", expiresAt: meta.expires_at };
    }

    async getInbox(username: string, domain: string): Promise<Result<{ inbox: InboxInfo }>> {
        const check = await this.checkActive(username);
        if (!check.ok) return check;
        return { ok: true, inbox: this.toInfo(check.meta, domain) };
    }

    // ---------------------------------------------------------------- email routing

    /**
     * Makes sure an Email Routing rule sends this address to the Worker. A no-op that returns
     * "not_configured" unless ZONE_ID and CF_TOKEN are set. Failures never block opening the inbox.
     */
    async ensureRouting(
        username: string,
        domain: string,
    ): Promise<Result<{ routing: RoutingStatus }>> {
        const check = await this.checkActive(username);
        if (!check.ok) return check;
        const cfg = getRoutingConfig(this.env);
        if (!cfg) return { ok: true, routing: "not_configured" };
        const address = this.toInfo(check.meta, domain).address;
        this.routingInFlight ??= (async (): Promise<RoutingStatus> => {
            try {
                const storedId =
                    await this.ctx.storage.get<string>(ROUTING_RULE_KEY);
                const stored = storedId ? await getRule(cfg, storedId) : null;
                if (stored) return statusOf(stored);
                const rule = await ensureRule(cfg, address);
                await this.ctx.storage.put(ROUTING_RULE_KEY, rule.id);
                log("info", "routing.rule_ready", { enabled: rule.enabled });
                return statusOf(rule);
            } catch (err) {
                log("error", "routing.ensure_failed", errorFields(err));
                return "unknown";
            } finally {
                this.routingInFlight = null;
            }
        })();
        return { ok: true, routing: await this.routingInFlight };
    }

    /**
     * Deletes the inbox right away: metadata, messages, alarm, registry entry and its Email
     * Routing rule. Mail to the address is rejected afterwards until it is opened again.
     */
    async deleteInbox(username: string): Promise<Result<{ deleted: true }>> {
        const check = await this.checkActive(username);
        if (!check.ok) return check;
        await this.purge("user", true);
        return { ok: true, deleted: true };
    }

    /**
     * Admin cleanup: deletes everything this object holds, whatever its state (active,
     * expired, or only a leftover routing rule id). Returns whether an inbox existed.
     */
    async wipe(): Promise<{ existed: boolean }> {
        const existed = this.readMeta() !== null;
        if (existed) await this.purge("admin", true);
        // Covers storage that purge() leaves alone, e.g. a rule id without inbox metadata.
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.schemaReady = false;
        return { existed };
    }

    /** Current state of this inbox's routing rule, read from the Cloudflare API. */
    async routingStatus(
        username: string,
    ): Promise<Result<{ routing: RoutingStatus }>> {
        const check = await this.checkActive(username);
        if (!check.ok) return check;
        const cfg = getRoutingConfig(this.env);

        if (!cfg) return { ok: true, routing: "not_configured" };
        const id = await this.ctx.storage.get<string>(ROUTING_RULE_KEY);
        if (!id) return { ok: true, routing: "not_configured" };
        try {
            return { ok: true, routing: statusOf(await getRule(cfg, id)) };
        } catch (err) {
            log("warn", "routing.status_failed", errorFields(err));
            return { ok: true, routing: "unknown" };
        }
    }

    // ---------------------------------------------------------------- messages

    async receiveEmail(
        input: ReceiveEmailInput,
    ): Promise<Result<{ id: string }>> {
        const check = await this.checkActive(input.username);
        if (!check.ok) return check;
        const meta = check.meta;
        const limits = getLimits(this.env);
        const size = input.raw.byteLength;
        const now = Date.now();

        if (size > limits.maxMessageBytes)
            return { ok: false, reason: "too_large" };

        const windowExpired =
            now - meta.rate_window_start >= INBOUND_RATE_WINDOW_MS;
        const rateCount = windowExpired ? 0 : meta.rate_count;
        if (rateCount >= INBOUND_RATE_MAX)
            return { ok: false, reason: "rate_limited" };

        if (
            meta.message_count + 1 > limits.maxMessagesPerInbox ||
            meta.total_bytes + size > limits.maxInboxBytes
        ) {
            return { ok: false, reason: "mailbox_full" };
        }

        const id = newMessageId(now);
        const p = input.parsed;
        const chunkCount = Math.max(1, Math.ceil(size / RAW_CHUNK_BYTES));

        try {
            this.ctx.storage.transactionSync(() => {
                this.sql.exec(
                    `INSERT INTO messages (id, received_at, envelope_from, envelope_to, from_addr, to_addr, cc, reply_to,
             subject, date_header, message_id_header, preview, size, chunk_count, attachment_count,
             attachments_json, headers_json, text_truncated, html_truncated, malformed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    id,
                    now,
                    input.envelopeFrom.slice(0, 500),
                    input.envelopeTo.slice(0, 500),
                    p.from,
                    p.to,
                    p.cc,
                    p.replyTo,
                    p.subject,
                    p.date,
                    p.messageIdHeader,
                    p.preview,
                    size,
                    chunkCount,
                    p.attachments.length,
                    JSON.stringify(p.attachments),
                    JSON.stringify(p.headers),
                    p.textTruncated ? 1 : 0,
                    p.htmlTruncated ? 1 : 0,
                    p.malformed ? 1 : 0,
                );
                if (p.text !== null) {
                    this.sql.exec(
                        `INSERT INTO bodies (message_id, kind, content) VALUES (?, 'text', ?)`,
                        id,
                        p.text,
                    );
                }
                if (p.html !== null) {
                    this.sql.exec(
                        `INSERT INTO bodies (message_id, kind, content) VALUES (?, 'html', ?)`,
                        id,
                        p.html,
                    );
                }
                for (let seq = 0; seq < chunkCount; seq++) {
                    const chunk = input.raw.slice(
                        seq * RAW_CHUNK_BYTES,
                        (seq + 1) * RAW_CHUNK_BYTES,
                    );
                    this.sql.exec(
                        `INSERT INTO raw_chunks (message_id, seq, data) VALUES (?, ?, ?)`,
                        id,
                        seq,
                        chunk.buffer,
                    );
                }
                this.sql.exec(
                    `UPDATE meta SET message_count = message_count + 1, total_bytes = total_bytes + ?,
             rate_window_start = ?, rate_count = ? WHERE id = 1`,
                    size,
                    windowExpired ? now : meta.rate_window_start,
                    rateCount + 1,
                );
            });
        } catch (err) {
            log("error", "inbox.store_failed", { size, ...errorFields(err) });
            return { ok: false, reason: "storage_error" };
        }
        return { ok: true, id };
    }

    async listEmails(
        username: string,
        domain: string,
    ): Promise<Result<{ inbox: InboxInfo; messages: MessageSummary[] }>> {
        const check = await this.checkActive(username);
        if (!check.ok) return check;
        const rows = this.sql
            .exec<MessageRow>(
                `SELECT ${MESSAGE_SUMMARY_COLUMNS} FROM messages ORDER BY received_at DESC, id DESC LIMIT 500`,
            )
            .toArray();
        return {
            ok: true,
            inbox: this.toInfo(check.meta, domain),
            messages: rows.map(toSummary),
        };
    }

    async getEmail(
        username: string,
        id: string,
    ): Promise<Result<{ message: MessageDetail }>> {
        const check = await this.checkActive(username);
        if (!check.ok) return check;
        const row = this.sql
            .exec<MessageRow>(`SELECT * FROM messages WHERE id = ?`, id)
            .toArray()[0];
        if (!row) return { ok: false, reason: "not_found" };
        const bodies = this.sql
            .exec<{
                kind: string;
                content: string;
            }>(`SELECT kind, content FROM bodies WHERE message_id = ?`, id)
            .toArray();
        const text = bodies.find((b) => b.kind === "text")?.content ?? null;
        const html = bodies.find((b) => b.kind === "html")?.content ?? null;
        return {
            ok: true,
            message: {
                ...toSummary(row),
                to: row.to_addr,
                cc: row.cc,
                replyTo: row.reply_to,
                date: row.date_header,
                messageIdHeader: row.message_id_header,
                text,
                html,
                textTruncated: row.text_truncated === 1,
                htmlTruncated: row.html_truncated === 1,
                malformed: row.malformed === 1,
                attachments: JSON.parse(
                    row.attachments_json,
                ) as AttachmentInfo[],
                headers: JSON.parse(row.headers_json) as Array<{
                    key: string;
                    value: string;
                }>,
            },
        };
    }

    /** Returns the stored raw .eml bytes, reassembled from chunks. */
    async getRawEmail(
        username: string,
        id: string,
    ): Promise<Result<{ raw: Uint8Array; size: number }>> {
        const check = await this.checkActive(username);
        if (!check.ok) return check;
        const row = this.sql
            .exec<{
                size: number;
            }>(`SELECT size FROM messages WHERE id = ?`, id)
            .toArray()[0];
        if (!row) return { ok: false, reason: "not_found" };
        const raw = new Uint8Array(row.size);
        let offset = 0;
        for (const chunk of this.sql.exec<{ data: ArrayBuffer }>(
            `SELECT data FROM raw_chunks WHERE message_id = ? ORDER BY seq`,
            id,
        )) {
            const bytes = new Uint8Array(chunk.data);
            raw.set(bytes, offset);
            offset += bytes.byteLength;
        }
        if (offset !== row.size) {
            log("error", "inbox.raw_size_mismatch", {
                expected: row.size,
                actual: offset,
            });
            return { ok: false, reason: "storage_error" };
        }
        return { ok: true, raw, size: row.size };
    }

    async deleteEmail(
        username: string,
        id: string,
    ): Promise<Result<{ deleted: true }>> {
        const check = await this.checkActive(username);
        if (!check.ok) return check;
        const deleted = this.ctx.storage.transactionSync(() => {
            const row = this.sql
                .exec<{
                    size: number;
                }>(`SELECT size FROM messages WHERE id = ?`, id)
                .toArray()[0];
            if (!row) return false;
            this.sql.exec(`DELETE FROM raw_chunks WHERE message_id = ?`, id);
            this.sql.exec(`DELETE FROM bodies WHERE message_id = ?`, id);
            this.sql.exec(`DELETE FROM messages WHERE id = ?`, id);
            this.sql.exec(
                `UPDATE meta SET message_count = message_count - 1, total_bytes = total_bytes - ? WHERE id = 1`,
                row.size,
            );
            return true;
        });
        return deleted
            ? { ok: true, deleted: true }
            : { ok: false, reason: "not_found" };
    }

    // ---------------------------------------------------------------- internals

    private ensureSchema(): void {
        if (this.schemaReady) return;
        this.sql.exec(SCHEMA);
        this.schemaReady = true;
    }

    private readMeta(): MetaRow | null {
        if (!this.schemaReady) return null;
        return (
            this.sql
                .exec<MetaRow>(`SELECT * FROM meta WHERE id = 1`)
                .toArray()[0] ?? null
        );
    }

    private async checkActive(
        username: string,
    ): Promise<
        { ok: true; meta: MetaRow } | { ok: false; reason: InboxFailure }
    > {
        if (await this.expireIfDue()) return { ok: false, reason: "expired" };
        const meta = this.readMeta();
        if (!meta) return { ok: false, reason: "not_found" };
        if (meta.username !== username) {
            // Unreachable when addressed by getByName(username); guards against cross-inbox access.
            log("error", "inbox.username_mismatch");
            return { ok: false, reason: "not_found" };
        }
        return { ok: true, meta };
    }

    /** Deletes the inbox when it is past expiry. Returns true when it did so. */
    private async expireIfDue(
        trigger: "lazy" | "cron" = "lazy",
    ): Promise<boolean> {
        const meta = this.readMeta();
        if (!meta || Date.now() < meta.expires_at) return false;
        return this.purge(trigger);
    }

    /**
     * Deletes the inbox. Unless `force` is set (an explicit delete by the user), it only runs
     * when the inbox is past expiry.
     */
    private async purge(trigger: string, force = false): Promise<boolean> {
        let username: string | null = null;
        let ruleId: string | undefined;
        await this.ctx.blockConcurrencyWhile(async () => {
            // Re-check under exclusive access: a heartbeat processed earlier wins.
            const meta = this.readMeta();
            if (!meta || (!force && Date.now() < meta.expires_at)) return;
            username = meta.username;
            ruleId = await this.ctx.storage.get<string>(ROUTING_RULE_KEY);
            await this.ctx.storage.deleteAlarm();
            await this.ctx.storage.deleteAll();
            this.schemaReady = false;
            log("info", force ? "inbox.deleted" : "inbox.expired", {
                trigger,
                messages: meta.message_count,
                bytes: meta.total_bytes,
                idleMs: Date.now() - meta.last_ping,
            });
        });
        if (username === null) return false;
        try {
            await registryStub(this.env, username).untrack(username);
        } catch (err) {
            log("warn", "registry.untrack_failed", errorFields(err));
        }
        // Free the slot: Email Routing allows at most 200 rules per zone. A rule left behind by
        // a failed delete is found and reused if the address is opened again.
        const cfg = getRoutingConfig(this.env);
        if (cfg && ruleId) {
            try {
                await deleteRule(cfg, ruleId);
            } catch (err) {
                log("warn", "routing.delete_failed", errorFields(err));
            }
        }
        return true;
    }

    private toInfo(meta: MetaRow, domain: string): InboxInfo {
        return {
            username: meta.username,
            address: `${meta.username}@${domain}`,
            createdAt: meta.created_at,
            lastPing: meta.last_ping,
            expiresAt: meta.expires_at,
            messageCount: meta.message_count,
            totalBytes: meta.total_bytes,
        };
    }
}

function toSummary(row: MessageRow): MessageSummary {
    return {
        id: row.id,
        receivedAt: row.received_at,
        from: row.from_addr || row.envelope_from,
        subject: row.subject,
        preview: row.preview,
        size: row.size,
        attachmentCount: row.attachment_count,
    };
}
