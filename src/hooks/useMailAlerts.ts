import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageSummary } from "../../shared/api-types";
import { senderName } from "../lib/format";
import { playChime } from "../lib/sound";
import { readJson, writeJson } from "../lib/storage";

const PREFS_KEY = "maildrop:alerts";
/** Read ids kept per inbox; older ids fall off (inboxes hold at most a few hundred). */
const MAX_READ_IDS = 500;

interface AlertPrefs {
  sound: boolean;
  notify: boolean;
}

export type NotifyPermission = NotificationPermission | "unsupported";

const readKey = (username: string) => `maildrop:read:${username}`;

function notificationPermission(): NotifyPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function pageIsAttended(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Alerts for incoming mail: a chime, a browser notification while the page is in the
 * background, and an unread count for the title and app badge. Messages already in the
 * inbox when the page loads never trigger alerts. Read state is kept per browser.
 */
export function useMailAlerts({
  username,
  messages,
  ready,
  onOpenMessage,
}: {
  username: string;
  messages: MessageSummary[];
  ready: boolean;
  onOpenMessage: (id: string) => void;
}) {
  const [prefs, setPrefs] = useState<AlertPrefs>(() => ({ sound: true, notify: false, ...readJson(PREFS_KEY, {}) }));
  const [permission, setPermission] = useState<NotifyPermission>(notificationPermission);
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set(readJson<string[]>(readKey(username), [])));
  const knownIds = useRef<Set<string> | null>(null);
  const openRef = useRef(onOpenMessage);
  useEffect(() => {
    openRef.current = onOpenMessage;
  }, [onOpenMessage]);

  const notifyEnabled = prefs.notify && permission === "granted";

  const updatePrefs = useCallback((patch: Partial<AlertPrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      writeJson(PREFS_KEY, next);
      return next;
    });
  }, []);

  const toggleSound = useCallback(() => updatePrefs({ sound: !prefs.sound }), [prefs.sound, updatePrefs]);

  /** Turns notifications on (asking for permission if needed) or off. */
  const toggleNotify = useCallback(async () => {
    if (notifyEnabled) return updatePrefs({ notify: false });
    if (permission === "unsupported" || permission === "denied") return;
    const result = permission === "granted" ? "granted" : await Notification.requestPermission();
    setPermission(result);
    if (result === "granted") updatePrefs({ notify: true });
  }, [notifyEnabled, permission, updatePrefs]);

  const markRead = useCallback(
    (id: string) => {
      setReadIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev).add(id);
        writeJson(readKey(username), [...next].slice(-MAX_READ_IDS));
        return next;
      });
    },
    [username],
  );

  // Detect messages that arrived since the previous poll.
  useEffect(() => {
    if (!ready) return;
    if (knownIds.current === null) {
      knownIds.current = new Set(messages.map((m) => m.id));
      return;
    }
    const known = knownIds.current;
    const fresh = messages.filter((m) => !known.has(m.id));
    for (const m of messages) known.add(m.id);
    if (fresh.length === 0) return;

    if (prefs.sound) playChime();
    if (notifyEnabled && !pageIsAttended()) {
      const first = fresh[0];
      const n = new Notification(
        fresh.length === 1 ? senderName(first.from) || "New message" : `${fresh.length} new messages`,
        {
          body: fresh.length === 1 ? first.subject || "(no subject)" : `${username} has new mail`,
          tag: `maildrop:${username}`, // A newer notification replaces the previous one.
          icon: "/favicon.svg",
        },
      );
      n.onclick = () => {
        window.focus();
        openRef.current(first.id);
        n.close();
      };
    }
  }, [messages, ready, prefs.sound, notifyEnabled, username]);

  // Permission can change in browser settings while the page is open.
  useEffect(() => {
    const sync = () => setPermission(notificationPermission());
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  const unreadIds = useMemo(() => new Set(messages.filter((m) => !readIds.has(m.id)).map((m) => m.id)), [messages, readIds]);
  const unreadCount = unreadIds.size;

  // App icon badge for installed PWAs, where supported.
  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    (unreadCount > 0 ? nav.setAppBadge(unreadCount) : nav.clearAppBadge!()).catch(() => {});
    return () => void nav.clearAppBadge?.().catch(() => {});
  }, [unreadCount]);

  return {
    sound: prefs.sound,
    notify: notifyEnabled,
    permission,
    toggleSound,
    toggleNotify,
    unreadIds,
    unreadCount,
    markRead,
  };
}
