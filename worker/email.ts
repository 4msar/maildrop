// Inbound mail: Email Routing catch-all rule -> this handler -> InboxDurableObject.

import {
    forwardAddresses,
    getLimits,
    mailDomain,
    orphanedEmailAction,
} from "./lib/config";
import { domainOf, errorFields, log } from "./lib/log";
import { parseRawEmail } from "./lib/mime";
import { usernameFromRecipient } from "../shared/username";
import type { InboxFailure } from "./inbox";

const REJECT_REASONS: Record<InboxFailure, string> = {
    not_found: "Mailbox does not exist",
    expired: "Mailbox does not exist",
    mailbox_full: "Mailbox full",
    rate_limited: "Mailbox is receiving too many messages, try again later",
    too_large: "Message too large",
    storage_error: "Temporary local problem, please try again later",
};

/** Reads a stream into memory, aborting once more than `limit` bytes have been read. */
async function readLimited(
    stream: ReadableStream<Uint8Array>,
    limit: number,
): Promise<Uint8Array | null> {
    const reader = stream.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            return null;
        }
        parts.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.byteLength;
    }
    return out;
}

export async function handleEmail(
    message: ForwardableEmailMessage,
    env: Env,
): Promise<void> {
    const limits = getLimits(env);
    const started = Date.now();
    const logBase = {
        fromDomain: domainOf(message.from),
        rawSize: message.rawSize,
    };

    // Without MAIL_DOMAIN/SITE_URL, accept whatever domain Email Routing delivered for: only
    // zones whose rules point at this Worker can reach it.
    const domain = mailDomain(
        env,
        message.to.slice(message.to.lastIndexOf("@") + 1),
    );
    const recipient = usernameFromRecipient(message.to, domain);
    if (!recipient || !recipient.ok) {
        log("info", "email.rejected", {
            ...logBase,
            reason: "invalid_recipient",
        });
        message.setReject("Mailbox does not exist");
        return;
    }
    const username = recipient.username;

    if (message.rawSize > limits.maxMessageBytes) {
        log("info", "email.rejected", { ...logBase, reason: "too_large" });
        message.setReject(REJECT_REASONS.too_large);
        return;
    }

    const stub = env.INBOX.getByName(username);
    try {
        // Cheap existence check before buffering and parsing the body.
        const inbox = await stub.getInbox(username, domain);
        if (!inbox.ok) {
            log("info", "email.rejected", { ...logBase, reason: inbox.reason });
            message.setReject(REJECT_REASONS[inbox.reason]);
            return;
        }

        const raw = await readLimited(message.raw, limits.maxMessageBytes);
        if (!raw) {
            log("info", "email.rejected", {
                ...logBase,
                reason: "too_large_stream",
            });
            message.setReject(REJECT_REASONS.too_large);
            return;
        }

        const parsed = await parseRawEmail(raw, message.from);
        if (parsed.malformed) log("warn", "email.malformed_mime", logBase);

        const result = await stub.receiveEmail({
            username,
            raw,
            parsed,
            envelopeFrom: message.from,
            envelopeTo: message.to,
        });
        if (!result.ok) {
            log(
                result.reason === "storage_error" ? "error" : "info",
                "email.rejected",
                { ...logBase, reason: result.reason },
            );
            message.setReject(REJECT_REASONS[result.reason]);
            return;
        }
        log("info", "email.stored", {
            ...logBase,
            messageId: result.id,
            attachments: parsed.attachments.length,
            ms: Date.now() - started,
        });
    } catch (err) {
        // Durable Object unavailable, overloaded, or another runtime error.
        log("error", "email.failed", { ...logBase, ...errorFields(err) });
        message.setReject(REJECT_REASONS.storage_error);
    }
}

/** Mail for a domain other than the mail domain: reject, forward or drop per ORPHANED_EMAIL_ACTION. */
export async function handleOrphanedEmail(
    message: ForwardableEmailMessage,
    env: Env,
): Promise<void> {
    const action = orphanedEmailAction(env);
    const logBase = {
        fromDomain: domainOf(message.from),
        toDomain: domainOf(message.to),
        rawSize: message.rawSize,
        action,
    };

    if (action === "drop") {
        // Accepting without storing or forwarding discards the message.
        log("info", "email.orphan_dropped", logBase);
        return;
    }

    const addresses = action === "forward" ? forwardAddresses(env) : [];
    if (addresses.length === 0) {
        log("info", "email.rejected", {
            ...logBase,
            reason: action === "forward" ? "no_forward_address" : "orphaned",
        });
        message.setReject("Mailbox does not exist");
        return;
    }

    // Forward to all destinations in parallel
    const forwarded = await Promise.allSettled(
        addresses.map((addr) => message.forward(addr)),
    );
    const successful = forwarded.filter((r) => r.status == "fulfilled");
    if (successful.length === 0) {
        message.setReject(REJECT_REASONS.storage_error);
        return;
    }
    log("info", "email.orphan_forwarded", {
        ...logBase,
        forwarded,
        failed: addresses.length - successful.length,
    });
}
