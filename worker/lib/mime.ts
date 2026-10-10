// MIME parsing with postal-mime. The raw .eml is always stored; the parsed summary is
// derived from it at receive time so listing and reading never re-parse the message.

import PostalMime, { type Address, type Attachment, type Email, type PostalMimeOptions } from "postal-mime";
import type { AttachmentInfo } from "../../shared/api-types";
import { MAX_BODY_BYTES, MAX_HEADERS_JSON_BYTES } from "./config";

const PARSE_OPTIONS: PostalMimeOptions = {
  maxNestingDepth: 50,
  maxPartCount: 500,
  maxHeadersSize: 512 * 1024,
  maxRfc822NestingDepth: 3,
};

export interface ParsedEmail {
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  date: string | null;
  messageIdHeader: string | null;
  text: string | null;
  html: string | null;
  textTruncated: boolean;
  htmlTruncated: boolean;
  preview: string;
  attachments: AttachmentInfo[];
  headers: Array<{ key: string; value: string }>;
  malformed: boolean;
}

function formatAddress(a: Address | undefined): string {
  if (!a) return "";
  if (a.group !== undefined) {
    return `${a.name}: ${a.group.map((m) => formatAddress(m)).join(", ")};`;
  }
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function formatAddressList(list: Address[] | undefined): string {
  return (list ?? []).map(formatAddress).join(", ");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** Truncates a string to at most `maxBytes` UTF-8 bytes. */
export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  // Drop a possibly split trailing code point (decoded as U+FFFD).
  const cut = decoder.decode(bytes.subarray(0, maxBytes)).replace(/�$/, "");
  return { value: cut, truncated: true };
}

function attachmentSize(att: Attachment): number {
  const c = att.content;
  if (typeof c === "string") return encoder.encode(c).byteLength;
  return c.byteLength;
}

function toAttachmentInfo(att: Attachment, index: number): AttachmentInfo {
  const disposition: AttachmentInfo["disposition"] =
    att.disposition === "inline" ? "inline" : att.disposition === "attachment" ? "attachment" : null;
  return {
    index,
    filename: sanitizeFilename(att.filename, index, att.mimeType),
    mimeType: att.mimeType || "application/octet-stream",
    size: attachmentSize(att),
    contentId: att.contentId ? att.contentId.replace(/^<|>$/g, "").slice(0, 255) : null,
    disposition,
  };
}

/** Strips path separators, control characters and quotes from attachment names. */
export function sanitizeFilename(name: string | null, index: number, mimeType: string): string {
  const cleaned = (name ?? "")
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 150);
  if (cleaned) return cleaned;
  const ext = mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "").slice(0, 10) || "bin";
  return `attachment-${index + 1}.${ext}`;
}

function makePreview(text: string | undefined, html: string | undefined): string {
  const source = text ?? (html ? html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ") : "");
  return source.replace(/\s+/g, " ").trim().slice(0, 200);
}

function limitHeaders(headers: Email["headers"]): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  let budget = MAX_HEADERS_JSON_BYTES;
  for (const h of headers) {
    const entry = { key: h.originalKey || h.key, value: h.value.slice(0, 4000) };
    budget -= entry.key.length + entry.value.length + 16;
    if (budget < 0) break;
    out.push(entry);
  }
  return out;
}

export function summarizeParsed(email: Email): ParsedEmail {
  const text = email.text !== undefined ? truncateUtf8(email.text, MAX_BODY_BYTES) : null;
  const html = email.html !== undefined ? truncateUtf8(email.html, MAX_BODY_BYTES) : null;
  return {
    from: formatAddress(email.from).slice(0, 500),
    to: formatAddressList(email.to).slice(0, 2000),
    cc: formatAddressList(email.cc).slice(0, 2000),
    replyTo: formatAddressList(email.replyTo).slice(0, 500),
    subject: (email.subject ?? "").slice(0, 998),
    date: email.date ?? null,
    messageIdHeader: email.messageId?.slice(0, 998) ?? null,
    text: text?.value ?? null,
    html: html?.value ?? null,
    textTruncated: text?.truncated ?? false,
    htmlTruncated: html?.truncated ?? false,
    preview: makePreview(email.text, email.html),
    attachments: email.attachments.map(toAttachmentInfo),
    headers: limitHeaders(email.headers),
    malformed: false,
  };
}

/**
 * Parses a raw message. Malformed MIME never throws: the message is still stored and
 * shown with whatever envelope information is available.
 */
export async function parseRawEmail(raw: Uint8Array, envelopeFrom: string): Promise<ParsedEmail> {
  try {
    return summarizeParsed(await PostalMime.parse(raw, PARSE_OPTIONS));
  } catch {
    return {
      from: envelopeFrom.slice(0, 500),
      to: "",
      cc: "",
      replyTo: "",
      subject: "(unparseable message)",
      date: null,
      messageIdHeader: null,
      text: null,
      html: null,
      textTruncated: false,
      htmlTruncated: false,
      preview: "This message could not be parsed. Download the raw .eml to inspect it.",
      attachments: [],
      headers: [],
      malformed: true,
    };
  }
}

export interface ExtractedAttachment {
  info: AttachmentInfo;
  content: Uint8Array;
}

/** Re-parses the stored raw message and returns one attachment by index. */
export async function extractAttachment(raw: Uint8Array, index: number): Promise<ExtractedAttachment | null> {
  let email: Email;
  try {
    email = await PostalMime.parse(raw, { ...PARSE_OPTIONS, attachmentEncoding: "arraybuffer" });
  } catch {
    return null;
  }
  const att = email.attachments[index];
  if (!att) return null;
  const content =
    typeof att.content === "string"
      ? encoder.encode(att.content)
      : att.content instanceof Uint8Array
        ? att.content
        : new Uint8Array(att.content);
  return { info: toAttachmentInfo(att, index), content };
}
