import { navigate } from "../lib/router";
import { MailIcon } from "./icons";

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
        <span className="hidden text-xs text-slate-500 sm:block dark:text-slate-400">
          Public, disposable inboxes. No signup.
        </span>
      </div>
    </header>
  );
}
