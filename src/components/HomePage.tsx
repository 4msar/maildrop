import { useState, type FormEvent } from "react";
import { checkUsername } from "../../shared/username";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { ShuffleIcon } from "./icons";

export function HomePage({ domain }: { domain: string }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"custom" | "random" | null>(null);

  async function openRandom() {
    setBusy("random");
    setError(null);
    try {
      const { inbox } = await api.openInbox();
      navigate(`/inbox/${inbox.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create an inbox.");
      setBusy(null);
    }
  }

  function openCustom(e: FormEvent) {
    e.preventDefault();
    const check = checkUsername(name);
    if (!check.ok) {
      setError(
        check.reason === "reserved_username"
          ? "That name is reserved. Please choose another."
          : "Use 3-32 characters: lowercase letters, digits, and single . _ or - between them.",
      );
      return;
    }
    setBusy("custom");
    // The inbox page opens (and creates) the inbox and handles server-side errors.
    navigate(`/inbox/${check.username}`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-16 sm:py-24">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Disposable email, <span className="text-brand-600">instantly</span>.
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-pretty text-slate-600 dark:text-slate-400">
          Get a throwaway inbox for sign-ups, testing and one-time codes. Inboxes are deleted 24 hours
          after you close them.
        </p>
      </div>

      <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-slate-800 dark:bg-slate-900">
        <button
          type="button"
          onClick={openRandom}
          disabled={busy !== null}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 font-medium text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60"
        >
          <ShuffleIcon className="size-4" />
          {busy === "random" ? "Creating…" : "Generate a random address"}
        </button>

        <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-slate-400">
          <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          or pick your own
          <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        </div>

        <form onSubmit={openCustom} noValidate>
          <label htmlFor="username" className="sr-only">
            Inbox name
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex flex-1 items-center rounded-xl border border-slate-300 bg-white focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20 dark:border-slate-700 dark:bg-slate-950">
              <input
                id="username"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder="hello"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={32}
                aria-invalid={error !== null}
                aria-describedby={error ? "username-error" : undefined}
                className="min-w-0 flex-1 bg-transparent px-4 py-3 outline-none placeholder:text-slate-400"
              />
              <span className="truncate pr-4 text-slate-500 dark:text-slate-400">@{domain}</span>
            </div>
            <button
              type="submit"
              disabled={busy !== null || name.trim() === ""}
              className="rounded-xl border border-slate-300 px-5 py-3 font-medium transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Open inbox
            </button>
          </div>
          {error && (
            <p id="username-error" role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </form>
      </div>

      <ul className="mt-8 grid gap-3 text-sm text-slate-600 sm:grid-cols-3 dark:text-slate-400">
        <li className="rounded-xl bg-white p-4 dark:bg-slate-900">
          <strong className="block text-slate-900 dark:text-slate-100">Public by design</strong>
          Anyone who knows an address can read it. Never use it for anything private.
        </li>
        <li className="rounded-xl bg-white p-4 dark:bg-slate-900">
          <strong className="block text-slate-900 dark:text-slate-100">Auto-expiring</strong>
          Kept alive while open. Deleted after 24 hours without a visit.
        </li>
        <li className="rounded-xl bg-white p-4 dark:bg-slate-900">
          <strong className="block text-slate-900 dark:text-slate-100">Safe preview</strong>
          HTML is sanitized and sandboxed; remote images are blocked by default.
        </li>
      </ul>
    </main>
  );
}
