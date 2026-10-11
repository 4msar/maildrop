import { useEffect, useState, type ReactNode } from "react";
import { checkUsername } from "../../shared/username";
import { useInbox } from "../hooks/useInbox";
import { useMailAlerts } from "../hooks/useMailAlerts";
import { formatDuration, formatRelative } from "../lib/format";
import { navigate } from "../lib/router";
import { CopyButton } from "./CopyButton";
import { BellIcon, BellOffIcon, ClockIcon, RefreshIcon, TrashIcon, VolumeIcon, VolumeOffIcon } from "./icons";
import { MessageList } from "./MessageList";
import { MessageView } from "./MessageView";
import { RoutingBadge } from "./RoutingBadge";

function DeleteInboxConfirm({
  address,
  messageCount,
  onCancel,
  onConfirm,
}: {
  address: string;
  messageCount: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this inbox.");
      setBusy(false);
    }
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby="delete-inbox-title"
      aria-describedby="delete-inbox-desc"
      className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/30"
    >
      <p id="delete-inbox-title" className="text-sm font-semibold text-red-800 dark:text-red-200">
        Delete this inbox?
      </p>
      <p id="delete-inbox-desc" className="mt-1 text-sm text-red-700 dark:text-red-300">
        <span className="font-medium break-all">{address}</span>
        {messageCount > 0 ? ` and its ${messageCount} message${messageCount === 1 ? "" : "s"}` : ""} will be
        removed permanently, and new mail to it will bounce. Anyone can open this address again later as an empty
        inbox.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
        >
          {busy ? "Deleting…" : "Delete inbox"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          autoFocus
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function CenteredCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-md px-4 py-20 text-center">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function InboxPage({ username, domain }: { username: string; domain: string }) {
  const valid = checkUsername(username);
  if (!valid.ok) {
    return (
      <CenteredCard title="That address isn't valid">
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {valid.reason === "reserved_username" ? "This name is reserved." : "Inbox names use 3-32 lowercase letters, digits, '.', '_' or '-'."}
        </p>
        <button type="button" onClick={() => navigate("/")} className="mt-6 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Choose another address
        </button>
      </CenteredCard>
    );
  }
  return <ReopenableInbox key={valid.username} username={valid.username} domain={domain} />;
}

function ReopenableInbox({ username, domain }: { username: string; domain: string }) {
  // Bumping the key remounts the inbox, which opens it again with fresh state.
  const [attempt, setAttempt] = useState(0);
  return <Inbox key={attempt} username={username} domain={domain} reopen={() => setAttempt((a) => a + 1)} />;
}

function Inbox({ username, domain, reopen }: { username: string; domain: string; reopen: () => void }) {
  const inbox = useInbox(username);
  const [selectedId, setSelectedIdState] = useState<string | null>(() => {
    const m = new URLSearchParams(window.location.search).get("m");
    return m && /^[0-9a-z]{26}$/.test(m) ? m : null;
  });
  // Mirror the selected message in ?m= so a message can be linked to directly.
  const setSelectedId = (id: string | null) => {
    setSelectedIdState(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("m", id);
    else url.searchParams.delete("m");
    window.history.replaceState(null, "", url);
  };
  const now = useNow(30_000);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);
  const address = inbox.inbox?.address ?? `${username}@${domain}`;
  const alerts = useMailAlerts({
    username,
    messages: inbox.messages,
    ready: inbox.status === "ready",
    onOpenMessage: setSelectedId,
  });
  const { markRead, unreadCount } = alerts;

  useEffect(() => {
    if (selectedId) markRead(selectedId);
  }, [selectedId, markRead]);

  useEffect(() => {
    document.title = `${unreadCount > 0 ? `(${unreadCount}) ` : ""}${address} · Maildrop`;
    return () => {
      document.title = "Maildrop · Disposable email, instantly";
    };
  }, [address, unreadCount]);

  if (inbox.status === "expired") {
    return (
      <CenteredCard title="This inbox has expired">
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          No one visited <span className="font-medium break-all">{address}</span> for 24 hours, so it and its
          messages were deleted. You can open it again as a fresh, empty inbox.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <button
            type="button"
            onClick={reopen}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Reopen this address
          </button>
          <button type="button" onClick={() => navigate("/")} className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
            New address
          </button>
        </div>
      </CenteredCard>
    );
  }

  if (inbox.status === "error") {
    return (
      <CenteredCard title="Couldn't open this inbox">
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{inbox.error}</p>
        <button type="button" onClick={reopen} className="mt-6 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Try again
        </button>
      </CenteredCard>
    );
  }

  const expiresIn = inbox.inbox ? inbox.inbox.expiresAt - now : null;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">Your inbox</p>
          {inbox.routing && <RoutingBadge status={inbox.routing} />}
          {inbox.routing === "not_configured" && (
            <button
              type="button"
              disabled={reconfiguring}
              onClick={async () => {
                setReconfiguring(true);
                await inbox.reconfigureRouting();
                setReconfiguring(false);
              }}
              title="Create the Email Routing rule for this address (and the inbox, if missing)"
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-600/30 ring-inset hover:bg-brand-50 disabled:opacity-60 dark:text-brand-100 dark:ring-brand-500/40 dark:hover:bg-brand-800/30"
            >
              <RefreshIcon className={`size-3 ${reconfiguring ? "animate-spin" : ""}`} />
              {reconfiguring ? "Reconfiguring…" : "Reconfigure"}
            </button>
          )}
        </div>
        <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-lg font-semibold break-all sm:text-xl">{address}</p>
          <div className="flex shrink-0 gap-2">
            <CopyButton text={address} />
            <button type="button" onClick={() => navigate("/")} className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              New address
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={!inbox.inbox || confirmingDelete}
              aria-label="Delete inbox"
              title="Delete inbox"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-slate-700 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <TrashIcon className="size-4" />
              <span className="hidden sm:inline">Delete</span>
            </button>
          </div>
        </div>
        {confirmingDelete && (
          <DeleteInboxConfirm
            address={address}
            messageCount={inbox.messages.length}
            onCancel={() => setConfirmingDelete(false)}
            onConfirm={async () => {
              await inbox.deleteInbox();
              navigate("/");
            }}
          />
        )}
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          <ClockIcon className="mr-1.5 inline size-3.5 align-[-2px]" />
          {expiresIn !== null
            ? `Kept alive while this page is open. Otherwise deleted in ${formatDuration(expiresIn)}.`
            : "Opening inbox…"}
          <span className="ml-1 hidden sm:inline">Anyone with this address can read it.</span>
        </p>
      </section>

      {inbox.error && (
        <p role="alert" className="mt-4 rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {inbox.error} Retrying automatically.
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:h-[calc(100vh-15rem)] lg:min-h-[32rem] lg:grid-cols-[22rem_1fr] dark:border-slate-800 dark:bg-slate-900">
        <section className={`min-w-0 min-h-0 flex-col border-slate-200 lg:border-r dark:border-slate-800 ${selectedId ? "hidden lg:flex" : "flex"}`}>
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
            <h2 className="text-sm font-semibold">
              Inbox{" "}
              {inbox.messages.length > 0 && <span className="text-slate-500">({inbox.messages.length})</span>}
              {unreadCount > 0 && (
                <span className="ml-1.5 rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {unreadCount} new
                </span>
              )}
            </h2>
            <div className="flex items-center gap-0.5">
              {alerts.permission !== "unsupported" && (
                <button
                  type="button"
                  onClick={() => void alerts.toggleNotify()}
                  disabled={alerts.permission === "denied"}
                  aria-pressed={alerts.notify}
                  aria-label={alerts.notify ? "Turn off desktop notifications" : "Turn on desktop notifications"}
                  title={
                    alerts.permission === "denied"
                      ? "Notifications are blocked for this site in your browser settings"
                      : alerts.notify
                        ? "Desktop notifications on"
                        : "Notify me about new mail"
                  }
                  className={`rounded-md p-1.5 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-800 ${alerts.notify ? "text-brand-600" : "text-slate-500"}`}
                >
                  {alerts.notify ? <BellIcon className="size-3.5" /> : <BellOffIcon className="size-3.5" />}
                </button>
              )}
              <button
                type="button"
                onClick={alerts.toggleSound}
                aria-pressed={alerts.sound}
                aria-label={alerts.sound ? "Mute new mail sound" : "Play a sound for new mail"}
                title={alerts.sound ? "Sound on" : "Sound off"}
                className={`rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 ${alerts.sound ? "text-brand-600" : "text-slate-500"}`}
              >
                {alerts.sound ? <VolumeIcon className="size-3.5" /> : <VolumeOffIcon className="size-3.5" />}
              </button>
            <button
              type="button"
              onClick={() => void inbox.refresh()}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              title={inbox.lastUpdated ? `Updated ${formatRelative(inbox.lastUpdated, now)}` : undefined}
            >
              <RefreshIcon className={`size-3.5 ${inbox.refreshing ? "animate-spin" : ""}`} />
              Refresh
            </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {inbox.status === "loading" ? (
              <ul className="animate-pulse divide-y divide-slate-100 dark:divide-slate-800" aria-busy="true" aria-label="Loading messages">
                {[0, 1, 2].map((i) => (
                  <li key={i} className="space-y-2 px-4 py-4">
                    <div className="h-3 w-1/2 rounded bg-slate-200 dark:bg-slate-800" />
                    <div className="h-3 w-3/4 rounded bg-slate-100 dark:bg-slate-800/60" />
                  </li>
                ))}
              </ul>
            ) : (
              <MessageList messages={inbox.messages} unreadIds={alerts.unreadIds} selectedId={selectedId} onSelect={setSelectedId} now={now} />
            )}
          </div>
        </section>

        <section className={`min-w-0 min-h-0 ${selectedId ? "block" : "hidden lg:block"}`}>
          {selectedId ? (
            <MessageView
              key={selectedId}
              username={username}
              messageId={selectedId}
              onBack={() => setSelectedId(null)}
              onDeleted={(id) => {
                inbox.removeMessage(id);
                setSelectedId(null);
              }}
              onGone={inbox.onGone}
            />
          ) : (
            <div className="hidden h-full items-center justify-center p-10 text-sm text-slate-500 lg:flex">
              Select a message to read it.
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
