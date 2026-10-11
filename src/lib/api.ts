import type { ApiError, ConfigResponse, InboxInfo, MessageDetail, MessageSummary, RoutingStatus } from "../../shared/api-types";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  /** The inbox no longer exists (expired, or never created). */
  get isGone(): boolean {
    return this.status === 410 || (this.status === 404 && this.code === "not_found");
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { Accept: "application/json", ...init?.headers } });
  } catch {
    throw new ApiRequestError(0, "network_error", "Network error. Check your connection.");
  }
  if (!res.ok) {
    let body: Partial<ApiError> = {};
    try {
      body = await res.json();
    } catch {
      // Non-JSON error page.
    }
    throw new ApiRequestError(res.status, body.error ?? "http_error", body.message ?? `Request failed (${res.status}).`);
  }
  return res.json() as Promise<T>;
}

const inboxPath = (username: string) => `/api/inboxes/${encodeURIComponent(username)}`;

export const api = {
  config: () => request<ConfigResponse>("/api/config"),

  openInbox: (username?: string) =>
    request<{ inbox: InboxInfo; routing: RoutingStatus }>("/api/inboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(username ? { username } : {}),
    }),

  heartbeat: (username: string) =>
    request<{ inbox: InboxInfo }>(`${inboxPath(username)}/heartbeat`, { method: "POST" }),

  routingStatus: (username: string) => request<{ routing: RoutingStatus }>(`${inboxPath(username)}/routing`),

  listMessages: (username: string) =>
    request<{ inbox: InboxInfo; messages: MessageSummary[] }>(`${inboxPath(username)}/messages`),

  getMessage: (username: string, id: string) =>
    request<{ message: MessageDetail }>(`${inboxPath(username)}/messages/${encodeURIComponent(id)}`),

  deleteMessage: (username: string, id: string) =>
    request<{ deleted: true }>(`${inboxPath(username)}/messages/${encodeURIComponent(id)}`, { method: "DELETE" }),

  rawUrl: (username: string, id: string) => `${inboxPath(username)}/messages/${encodeURIComponent(id)}/raw`,

  attachmentUrl: (username: string, id: string, index: number, inline = false) =>
    `${inboxPath(username)}/messages/${encodeURIComponent(id)}/attachments/${index}${inline ? "?inline=1" : ""}`,
};
