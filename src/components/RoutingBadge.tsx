import type { RoutingStatus } from "../../shared/api-types";

const VARIANTS: Record<RoutingStatus, { label: string; title: string; className: string; dot: string }> = {
  enabled: {
    label: "Receiving enabled",
    title: "An Email Routing rule sends this address to maildrop.",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-400/30",
    dot: "bg-emerald-500",
  },
  disabled: {
    label: "Routing disabled",
    title: "The Email Routing rule for this address exists but is turned off.",
    className: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-400/30",
    dot: "bg-amber-500",
  },
  not_configured: {
    label: "Routing not configured",
    title: "No Email Routing rule exists for this address. Mail arrives only if a catch-all rule sends it here.",
    className: "bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/20",
    dot: "bg-slate-400",
  },
  unknown: {
    label: "Routing status unavailable",
    title: "The Cloudflare API could not be reached to check this address's routing rule.",
    className: "bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-400/20",
    dot: "bg-slate-400",
  },
};

export function RoutingBadge({ status }: { status: RoutingStatus }) {
  const v = VARIANTS[status];
  return (
    <span
      title={v.title}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${v.className}`}
    >
      <span className={`size-1.5 rounded-full ${v.dot}`} aria-hidden="true" />
      {v.label}
    </span>
  );
}
