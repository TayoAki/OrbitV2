// Inline SVG icon set — no external icon dependency (Artifact/CSP-safe habit).
// Stroke icons inherit currentColor; a few glyphs are filled where it reads better.
import React from "react";

type P = { size?: number; className?: string; strokeWidth?: number };

const svg = (size: number, children: React.ReactNode, extra?: string, sw = 1.7) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={extra}
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const Icons = {
  inbox: (p: P = {}) =>
    svg(p.size ?? 18, <><path d="M4 13h3l2 3h6l2-3h3" /><path d="M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7" /><path d="M4 13v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>, p.className, p.strokeWidth),
  board: (p: P = {}) =>
    svg(p.size ?? 18, <><rect x="3" y="4" width="6" height="16" rx="1.5" /><rect x="10.5" y="4" width="6" height="10" rx="1.5" /><rect x="18" y="4" width="3" height="13" rx="1.2" /></>, p.className, p.strokeWidth),
  threads: (p: P = {}) =>
    svg(p.size ?? 18, <path d="M21 11.5a8.38 8.38 0 0 1-9 8.3 9 9 0 0 1-3-.6L3 21l1.9-4.5A8.38 8.38 0 0 1 4 12a8.5 8.5 0 0 1 8.5-8.5A8.38 8.38 0 0 1 21 11.5z" />, p.className, p.strokeWidth),
  members: (p: P = {}) =>
    svg(p.size ?? 18, <><path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" /><circle cx="9" cy="7" r="3.2" /><path d="M22 20v-1.5a4 4 0 0 0-3-3.85" /><path d="M16 4.15A4 4 0 0 1 16 11.5" /></>, p.className, p.strokeWidth),
  connections: (p: P = {}) =>
    svg(p.size ?? 18, <><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" /></>, p.className, p.strokeWidth),
  search: (p: P = {}) => svg(p.size ?? 16, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3-3" /></>, p.className, p.strokeWidth),
  gear: (p: P = {}) =>
    svg(p.size ?? 18, <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 8.5 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H2a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 3.6 8.5a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H8a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V8a1.6 1.6 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></>, p.className, 1.4),
  sun: (p: P = {}) => svg(p.size ?? 16, <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>, p.className, p.strokeWidth),
  moon: (p: P = {}) => svg(p.size ?? 16, <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />, p.className, p.strokeWidth),
  chevronDown: (p: P = {}) => svg(p.size ?? 15, <path d="m6 9 6 6 6-6" />, p.className, p.strokeWidth),
  chevronRight: (p: P = {}) => svg(p.size ?? 15, <path d="m9 6 6 6-6 6" />, p.className, p.strokeWidth),
  external: (p: P = {}) => svg(p.size ?? 15, <><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>, p.className, p.strokeWidth),
  close: (p: P = {}) => svg(p.size ?? 16, <path d="M18 6 6 18M6 6l12 12" />, p.className, p.strokeWidth),
  check: (p: P = {}) => svg(p.size ?? 15, <path d="M20 6 9 17l-5-5" />, p.className, 2),
  checkCircle: (p: P = {}) => svg(p.size ?? 16, <><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>, p.className, p.strokeWidth),
  alert: (p: P = {}) => svg(p.size ?? 16, <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>, p.className, p.strokeWidth),
  build: (p: P = {}) => svg(p.size ?? 16, <><circle cx="12" cy="12" r="9" opacity=".9" /><path d="M12 7v5l3 2" /></>, p.className, p.strokeWidth),
  pr: (p: P = {}) => svg(p.size ?? 16, <><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><path d="M6 8.4v7.2" /><circle cx="17" cy="7" r="2.4" /><path d="M17 9.4v3a4 4 0 0 1-4 4H8.4" /></>, p.className, p.strokeWidth),
  merge: (p: P = {}) => svg(p.size ?? 16, <><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="17" cy="12" r="2.4" /><path d="M6 8.4v7.2" /><path d="M6 12a6 6 0 0 0 6 6h2.6" /></>, p.className, p.strokeWidth),
  review: (p: P = {}) => svg(p.size ?? 16, <><path d="M21 11.5a8 8 0 0 1-8.5 8 8.5 8.5 0 0 1-3-.6L3 21l1.9-4.5A8 8 0 1 1 21 11.5z" /><path d="M9 10.5h6M9 13.5h4" /></>, p.className, p.strokeWidth),
  ready: (p: P = {}) => svg(p.size ?? 16, <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /></>, p.className, p.strokeWidth),
  pickup: (p: P = {}) => svg(p.size ?? 16, <><path d="M12 3v10" /><path d="m8 11 4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>, p.className, p.strokeWidth),
  abort: (p: P = {}) => svg(p.size ?? 16, <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></>, p.className, p.strokeWidth),
  plus: (p: P = {}) => svg(p.size ?? 16, <path d="M12 5v14M5 12h14" />, p.className, 2),
  arrowRight: (p: P = {}) => svg(p.size ?? 18, <path d="M5 12h14M13 6l6 6-6 6" />, p.className, p.strokeWidth),
  sort: (p: P = {}) => svg(p.size ?? 14, <><path d="M4 6h16M6 12h12M9 18h6" /></>, p.className, p.strokeWidth),
  person: (p: P = {}) => svg(p.size ?? 14, <><circle cx="12" cy="8" r="3.4" /><path d="M5 20a7 7 0 0 1 14 0" /></>, p.className, p.strokeWidth),
  repo: (p: P = {}) => svg(p.size ?? 14, <><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v4H6.5A2.5 2.5 0 0 1 4 20.5z" /></>, p.className, p.strokeWidth),
  github: (p: P = {}) => (
    <svg width={p.size ?? 20} height={p.size ?? 20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={p.className}>
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.5 2.87 8.32 6.84 9.67.5.09.68-.22.68-.48v-1.7c-2.78.62-3.37-1.2-3.37-1.2-.46-1.18-1.11-1.5-1.11-1.5-.9-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9v2.82c0 .27.18.58.69.48A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2z" />
    </svg>
  ),
  key: (p: P = {}) => svg(p.size ?? 16, <><circle cx="7.5" cy="15.5" r="4" /><path d="M10.3 12.7 20 3" /><path d="M16 7l3 3" /><path d="M13 10l3 3" /></>, p.className, p.strokeWidth),
  menu: (p: P = {}) => svg(p.size ?? 18, <><path d="M4 6h16M4 12h16M4 18h16" /></>, p.className, p.strokeWidth),
  mail: (p: P = {}) => svg(p.size ?? 16, <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></>, p.className, p.strokeWidth),
  logout: (p: P = {}) => svg(p.size ?? 16, <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h12" /></>, p.className, p.strokeWidth),
  robot: (p: P = {}) => svg(p.size ?? 14, <><rect x="4" y="8" width="16" height="11" rx="2.5" /><path d="M12 8V4M9 4h6" /><circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none" /></>, p.className, p.strokeWidth),
};

export type IconName = keyof typeof Icons;

export function Icon({ name, size, className }: { name: IconName; size?: number; className?: string }) {
  const fn = Icons[name];
  return fn ? fn({ size, className }) : null;
}
