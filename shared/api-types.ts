// Types shared by the Worker API and the React client.

export interface InboxInfo {
  username: string;
  address: string;
  createdAt: number;
  lastPing: number;
  expiresAt: number;
  messageCount: number;
  totalBytes: number;
}

export interface AttachmentInfo {
  /** Position of the attachment in the parsed MIME message. Used as its public identifier. */
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  disposition: "attachment" | "inline" | null;
}

export interface MessageSummary {
  id: string;
  receivedAt: number;
  from: string;
  subject: string;
  preview: string;
  size: number;
  attachmentCount: number;
}

export interface MessageDetail extends MessageSummary {
  to: string;
  cc: string;
  replyTo: string;
  date: string | null;
  messageIdHeader: string | null;
  text: string | null;
  html: string | null;
  textTruncated: boolean;
  htmlTruncated: boolean;
  malformed: boolean;
  attachments: AttachmentInfo[];
  headers: Array<{ key: string; value: string }>;
}

export type ApiErrorCode =
  | "invalid_username"
  | "reserved_username"
  | "invalid_message_id"
  | "invalid_attachment"
  | "not_found"
  | "inbox_expired"
  | "rate_limited"
  | "unauthorized"
  | "bad_request"
  | "internal_error";

export interface ApiError {
  error: ApiErrorCode;
  message: string;
}

/**
 * Email Routing rule for an inbox address.
 * - enabled: a rule sends this address to the Worker.
 * - disabled: the rule exists but is turned off in the dashboard.
 * - not_configured: no rule (ZONE_ID/CF_TOKEN unset, or the rule is missing).
 * - unknown: the Cloudflare API could not be reached.
 */
export type RoutingStatus = "enabled" | "disabled" | "not_configured" | "unknown";

export interface ConfigResponse {
  domain: string;
  ttlHours: number;
  heartbeatIntervalMinutes: number;
  maxMessageBytes: number;
}
