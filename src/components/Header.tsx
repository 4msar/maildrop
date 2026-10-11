import { navigate } from "../lib/router";
import { GitHubIcon, MailIcon } from "./icons";

export function Header() {
  return (
    <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
          className="flex items-center gap-2 font-semibold tracking-tight"
        >
          <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white">
            <MailIcon className="size-4.5" />
          </span>
          maildrop
        </a>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-slate-500 sm:block dark:text-slate-400">
            Public, disposable inboxes. No signup.
          </span>
          <a
            href="https://github.com/4msar/maildrop"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Maildrop source code on GitHub"
            title="View source on GitHub"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
          >
            <GitHubIcon className="size-4" />
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}
