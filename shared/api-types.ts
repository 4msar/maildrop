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
  | "bad_request"
  | "internal_error";

export interface ApiError {
  error: ApiErrorCode;
  message: string;
}

export interface ConfigResponse {
  domain: string;
  ttlHours: number;
  heartbeatIntervalMinutes: number;
  maxMessageBytes: number;
}
