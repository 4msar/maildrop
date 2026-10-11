import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxInfo, MessageSummary, RoutingStatus } from "../../shared/api-types";
import { ApiRequestError, api } from "../lib/api";

const HEARTBEAT_MS = 60 * 60 * 1000; // matches HEARTBEAT_INTERVAL_MS on the server
const POLL_VISIBLE_MS = 8_000;
const POLL_HIDDEN_MS = 60_000;

export type InboxStatus = "loading" | "ready" | "expired" | "error";

export interface InboxState {
  status: InboxStatus;
  inbox: InboxInfo | null;
  messages: MessageSummary[];
  error: string | null;
  refreshing: boolean;
  lastUpdated: number | null;
  /** Email Routing rule state for this address; null until known. */
  routing: RoutingStatus | null;
}

/**
 * Opens an inbox, keeps it alive with heartbeats while the page is open, and polls for
 * new messages. Heartbeats: one immediately on open, then hourly; a heartbeat is
 * also sent when the tab becomes visible again if the last one is more than an hour old
 * (browsers throttle timers in background tabs).
 */
export function useInbox(username: string) {
  const [state, setState] = useState<InboxState>({
    status: "loading",
    inbox: null,
    messages: [],
    error: null,
    refreshing: false,
    lastUpdated: null,
    routing: null,
  });
  const lastHeartbeat = useRef(0);
  const alive = useRef(true);

  const markExpired = useCallback(() => {
    alive.current = false;
    setState((s) => ({ ...s, status: "expired", messages: [], refreshing: false, routing: null }));
  }, []);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiRequestError && err.isGone) return markExpired();
      const message = err instanceof Error ? err.message : "Something went wrong.";
      // Keep showing existing messages on transient errors; surface the error alongside.
      setState((s) => ({ ...s, status: s.inbox ? "ready" : "error", error: message, refreshing: false }));
    },
    [markExpired],
  );

  const sendHeartbeat = useCallback(async () => {
    if (!alive.current) return;
    try {
      const { inbox } = await api.heartbeat(username);
      lastHeartbeat.current = Date.now();
      setState((s) => ({ ...s, inbox }));
    } catch (err) {
      handleError(err);
    }
  }, [username, handleError]);

  const refresh = useCallback(async () => {
    if (!alive.current) return;
    setState((s) => ({ ...s, refreshing: true }));
    try {
      const { inbox, messages } = await api.listMessages(username);
      setState((s) => ({ ...s, status: "ready", inbox, messages, error: null, refreshing: false, lastUpdated: Date.now() }));
    } catch (err) {
      handleError(err);
    }
  }, [username, handleError]);

  // Open: send the heartbeat immediately; if the inbox does not exist (never created, or
  // expired), create it. Creating also records lastPing, so it counts as the first ping.
  // Reloading an existing inbox therefore never spends the stricter create rate limit.
  useEffect(() => {
    // Callers key the component by username + reopen count, so state starts fresh here.
    let cancelled = false;
    alive.current = true;
    (async () => {
      try {
        let inbox;
        let routing: RoutingStatus | null = null;
        try {
          ({ inbox } = await api.heartbeat(username));
        } catch (err) {
          if (!(err instanceof ApiRequestError && err.isGone)) throw err;
          // Creating the inbox also creates its routing rule (when the server is configured to).
          ({ inbox, routing } = await api.openInbox(username));
        }
        if (cancelled) return;
        lastHeartbeat.current = Date.now();
        setState((s) => ({ ...s, inbox, routing: routing ?? s.routing }));
        if (routing === null) {
          // Best effort: the badge simply stays hidden if this fails.
          api.routingStatus(username).then(
            (r) => !cancelled && setState((s) => ({ ...s, routing: r.routing })),
            () => {},
          );
        }
        await refresh();
      } catch (err) {
        if (!cancelled) handleError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [username, refresh, handleError]);

  // Hourly heartbeat, plus catch-up when the tab becomes visible.
  useEffect(() => {
    const interval = window.setInterval(sendHeartbeat, HEARTBEAT_MS);
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastHeartbeat.current >= HEARTBEAT_MS) void sendHeartbeat();
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sendHeartbeat, refresh]);

  // Message polling: faster while visible.
  useEffect(() => {
    if (state.status !== "ready") return;
    let timer: number;
    const tick = () => {
      timer = window.setTimeout(
        async () => {
          await refresh();
          tick();
        },
        document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS,
      );
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [state.status, refresh]);

  const removeMessage = useCallback((id: string) => {
    setState((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== id) }));
  }, []);

  /** Deletes the inbox on the server. Polling and heartbeats stop first so they cannot race it. */
  const deleteInbox = useCallback(async () => {
    alive.current = false;
    try {
      await api.deleteInbox(username);
    } catch (err) {
      if (err instanceof ApiRequestError && err.isGone) return; // Already gone: same outcome.
      alive.current = true;
      throw err;
    }
  }, [username]);

  /**
   * Re-opens the inbox on the server, which recreates it if missing and creates its Email
   * Routing rule if there is none. Used when routing reports "not_configured".
   */
  const reconfigureRouting = useCallback(async () => {
    if (!alive.current) return;
    try {
      const { inbox, routing } = await api.openInbox(username);
      setState((s) => ({ ...s, status: "ready", inbox, routing, error: null }));
    } catch (err) {
      handleError(err);
    }
  }, [username, handleError]);

  return { ...state, refresh, removeMessage, deleteInbox, reconfigureRouting, onGone: markExpired };
}
