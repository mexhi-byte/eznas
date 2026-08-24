import type { ReactNode } from "react";
import { level } from "./api";

/** What this thing is, in one line — on the sign-in page and under Settings. */
export const TAGLINE =
  "A beautifully simplified, open-source web UI for TrueNAS. Built for homelabs, powered by WebSockets.";

export function Card({ title, action, children, className = "" }: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card ${className}`}>
      {(title || action) && (
        <div className="card-head">
          <span className="card-title">{title}</span>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value, unit, foot, children }: {
  label: string;
  value: ReactNode;
  unit?: string;
  foot?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="card">
      <div className="stat">
        <span className="stat-label">{label}</span>
        <span className="stat-value">
          {value}
          {unit && <small>{unit}</small>}
        </span>
        {children}
        {foot && <span className="stat-foot">{foot}</span>}
      </div>
    </div>
  );
}

export function Bar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className={`bar ${level(clamped)}`}>
      <i style={{ width: `${clamped}%` }} />
    </div>
  );
}

const TONE: Record<string, string> = {
  ONLINE: "ok", RUNNING: "ok", HEALTHY: "ok", AVAIL: "ok", true: "ok",
  DEGRADED: "warn", WARNING: "warn", DEPLOYING: "warn",
  FAULTED: "bad", OFFLINE: "bad", UNAVAIL: "bad", CRASHED: "bad", ERROR: "bad", CRITICAL: "bad", ALERT: "bad", EMERGENCY: "bad",
  STOPPED: "mute", INFO: "info", NOTICE: "info",
};

export function Pill({ state, children }: { state: string; children?: ReactNode }) {
  const tone = TONE[state?.toUpperCase?.() ?? ""] ?? "mute";
  return (
    <span className={`pill ${tone}`}>
      <i className="dot" />
      {children ?? state}
    </span>
  );
}

/**
 * A minute of history, drawn as a filled line.
 *
 * The vertical scale is the series' own maximum, not an absolute one: network
 * throughput spans several orders of magnitude between idle and a restore, and
 * a fixed axis would leave the line flat on the floor almost always.
 */
export function Sparkline({ points, max, color = "var(--accent)" }: {
  points: number[];
  max?: number;
  color?: string;
}) {
  const w = 240;
  const h = 38;
  if (points.length < 2) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" />;

  const top = max ?? Math.max(...points, 1);
  const step = w / (points.length - 1);
  const y = (v: number) => h - 2 - (Math.min(v, top) / top) * (h - 5);
  const line = points.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  const id = `fill-${color.replace(/[^a-z]/gi, "")}`;

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="area" d={area} fill={`url(#${id})`} />
      <path className="line" d={line} stroke={color} />
    </svg>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return <div className="error-banner">{children}</div>;
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid" style={{ gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 44 }} />
      ))}
    </div>
  );
}

/* Icons — inline so the page needs no icon font and no network request. */
const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

export const Icons = {
  overview: icon(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>),
  storage: icon(<><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /><path d="M4 11.5v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></>),
  datasets: icon(<><path d="M3 6h7l2 2h9v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></>),
  apps: icon(<><rect x="3" y="3" width="7" height="7" rx="1.6" /><rect x="14" y="3" width="7" height="7" rx="1.6" /><rect x="3" y="14" width="7" height="7" rx="1.6" /><rect x="14" y="14" width="7" height="7" rx="1.6" /></>),
  disks: icon(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /><path d="M16.5 16.5 20 20" /></>),
  shares: icon(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>),
  alerts: icon(<><path d="M12 3a6 6 0 0 0-6 6c0 4-2 5-2 7h16c0-2-2-3-2-7a6 6 0 0 0-6-6z" /><path d="M10 20a2 2 0 0 0 4 0" /></>),
  services: icon(<><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /><path d="m19.4 15-.7 1.2a1.6 1.6 0 0 0 .3 2l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.6 1.6 0 0 0-2-.3 1.6 1.6 0 0 0-1 1.5v.2a1.9 1.9 0 1 1-3.8 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-2 .3l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.6 1.6 0 0 0 .3-2 1.6 1.6 0 0 0-1.5-1H3a1.9 1.9 0 1 1 0-3.8h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-2l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.6 1.6 0 0 0 2 .3h.1a1.6 1.6 0 0 0 1-1.5V3a1.9 1.9 0 1 1 3.8 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 2-.3l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.6 1.6 0 0 0-.3 2v.1a1.6 1.6 0 0 0 1.5 1h.2a1.9 1.9 0 1 1 0 3.8h-.1a1.6 1.6 0 0 0-1.5 1z" /></>),
  snapshots: icon(<><path d="M12 21a9 9 0 1 0-9-9" /><path d="M3 3v5h5" /><circle cx="12" cy="12" r="3" /></>),
  files: icon(<><path d="M3 6h6l2 2h10v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M8 13h8" /><path d="M8 16.5h5" /></>),
  catalog: icon(<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>),
  users: icon(<><circle cx="9" cy="8" r="3.2" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" /><path d="M17.5 14.3A6.5 6.5 0 0 1 21.5 20" /></>),
  settings: icon(<><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" /><circle cx="8" cy="18" r="2" fill="currentColor" stroke="none" /></>),
  network: icon(<><rect x="2" y="14" width="20" height="7" rx="2" /><path d="M6 17.5h.01M10 17.5h.01" /><path d="M12 14v-4" /><path d="M7 10h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2z" /></>),
  terminal: icon(<><rect x="2.5" y="4" width="19" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></>),
  logout: icon(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>),
  refresh: icon(<><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></>),
};
