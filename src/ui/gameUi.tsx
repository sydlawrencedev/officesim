import { useEffect, type ReactNode } from "react";

/*
 * Window chrome in the style of classic park-builder sim games: bevelled stone-coloured panels,
 * a dark title bar, icon tabs along the top of the window and sunken fields and viewports.
 */

// A plain monospace that keeps 2 and 8, 0 and O, 1 and l apart at small sizes
const FONT_HREF = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap";
const FONT_LINK_ID = "officesim-game-font";

const CSS = `
.op-root {
  --op-font: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --op-face: #6f8295;
  --op-hi: #a9bacb;
  --op-lo: #3a4a5b;
  --op-deep: #243140;
  --op-tab: #5f7185;
  --op-title: #2c3d52;
  --op-title-ink: #f4f1e4;
  --op-ink: #101820;
  --op-field: #1b2530;
  --op-field-ink: #e8f0d8;
}
.op-window {
  font-family: var(--op-font);
  color: var(--op-ink);
  background: var(--op-face);
  border: 2px solid;
  border-color: var(--op-hi) var(--op-lo) var(--op-lo) var(--op-hi);
  box-shadow: 0 0 0 1px #0a0f15, 4px 4px 0 rgba(0,0,0,0.35);
}
/* Full screen (or a host the window fills): the window fills it and the camera (or panel) takes all the room left */
.op-root-fill { height: 100vh; padding: 0 !important; overflow: hidden; }
:is(.op-window:fullscreen, .op-window-fill) { display: flex; flex-direction: column; width: 100vw; height: 100vh; box-sizing: border-box; box-shadow: none; border: 0; }
:is(.op-window:fullscreen, .op-window-fill) .op-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
:is(.op-window:fullscreen, .op-window-fill) .op-viewport { flex: 1; height: auto !important; min-height: 0 !important; }
:is(.op-window:fullscreen, .op-window-fill) .op-viewport > div:first-child { height: 100% !important; min-height: 0 !important; }
:is(.op-window:fullscreen, .op-window-fill) .op-list-body { max-height: none; }
/* Filling the host's frame (the plugin page): the same, at the height measured for it, keeping the window's border */
.op-window-frame:not(:fullscreen) { display: flex; flex-direction: column; box-sizing: border-box; }
.op-window-frame:not(:fullscreen) .op-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
.op-window-frame:not(:fullscreen) .op-viewport { flex: 1; height: auto !important; min-height: 0 !important; }
.op-window-frame:not(:fullscreen) .op-viewport > div:first-child { height: 100% !important; min-height: 0 !important; }
.op-window-frame:not(:fullscreen) .op-list-body { max-height: none; }
.op-window-frame:not(:fullscreen) .op-settings { max-height: none; flex: 1; }
.op-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 2px 2px 0;
  padding: 3px 8px 4px;
  background: var(--op-title);
  border: 1px solid;
  border-color: #56708e #141e2a #141e2a #56708e;
  color: var(--op-title-ink);
  font-size: 15px;
  font-weight: 600;
  text-shadow: 1px 1px 0 #000;
}
.op-titlebar-sub { font-weight: 400; opacity: 0.8; }
.op-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 6px 0;
}
.op-tabs { display: flex; gap: 2px; align-items: flex-end; }
.op-tab {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 52px;
  margin-bottom: -2px;
  padding: 4px 6px 3px;
  font: inherit;
  font-family: var(--op-font);
  font-size: 12px;
  line-height: 1;
  color: var(--op-ink);
  background: var(--op-tab);
  border: 2px solid;
  border-color: var(--op-hi) var(--op-lo) var(--op-hi) var(--op-hi);
  border-radius: 3px 3px 0 0;
  cursor: pointer;
  white-space: nowrap;
  transform: translateY(2px);
}
.op-tab:hover { filter: brightness(1.08); }
.op-tab[aria-pressed="true"] {
  z-index: 1;
  padding-bottom: 7px;
  background: var(--op-face);
  border-bottom-color: var(--op-face);
  transform: none;
  font-weight: 600;
}
.op-tab-icon { font-size: 17px; line-height: 1.1; }
.op-tab-badge { position: absolute; top: -16px; right: -12px; z-index: 2; pointer-events: none; line-height: 0; }
.op-pixel-sprite { display: block; shape-rendering: crispEdges; }
.op-tab:focus-visible, .op-dropdown select:focus-visible, .op-button:focus-visible { outline: 1px dotted var(--op-ink); outline-offset: -4px; }
.op-controls { display: flex; gap: 6px; align-items: center; padding-bottom: 5px; }
.op-dropdown {
  position: relative;
  display: flex;
  border: 1px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
}
.op-dropdown select {
  appearance: none;
  -webkit-appearance: none;
  padding: 4px 26px 4px 6px;
  font-family: var(--op-font);
  font-size: 13px;
  color: var(--op-field-ink);
  background: var(--op-field);
  border: 0;
  border-radius: 0;
  cursor: pointer;
}
.op-dropdown::after {
  content: "▼";
  position: absolute;
  top: 1px;
  right: 1px;
  bottom: 1px;
  width: 18px;
  display: grid;
  place-items: center;
  font-size: 8px;
  color: var(--op-ink);
  background: var(--op-face);
  border: 1px solid;
  border-color: var(--op-hi) var(--op-lo) var(--op-lo) var(--op-hi);
  pointer-events: none;
}
.op-status {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  font-size: 13px;
  color: var(--op-field-ink);
  background: var(--op-field);
  border: 1px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
}
.op-window-main { position: relative; }
.op-log { display: flex; flex-direction: column; }
.op-log-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.op-log-filter {
  flex: 1;
  max-width: 320px;
  padding: 4px 6px;
  font-family: var(--op-font);
  font-size: 12px;
  color: var(--op-field-ink);
  background: rgba(0,0,0,0.25);
  border: 1px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
  border-radius: 0;
}
.op-log-filter::placeholder { color: #7d8fa3; }
.op-log-filter:focus { outline: 1px dotted var(--op-field-ink); outline-offset: 1px; }
.op-log-count { font-size: 12px; color: #9fb3c6; white-space: nowrap; }
.op-log-repo { display: flex; align-items: baseline; gap: 10px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-log-repo-section { border-bottom: 1px solid rgba(255,255,255,0.08); }
.op-log-repo-section .op-log-section { display: flex; align-items: baseline; gap: 10px; }
.op-log-branch { font-weight: 400; font-size: 12px; color: #6ee36e; }
.op-log-body { max-height: min(600px, calc(100vh - 300px)); min-height: 220px; overflow-y: auto; }
.op-log-section {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #f5d547;
  background: #16202a;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.op-log-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 7px 8px;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.op-log-row:nth-child(even) { background: rgba(255,255,255,0.03); }
button.op-log-row { cursor: pointer; }
button.op-log-row:hover { background: rgba(245,213,71,0.1); }
button.op-log-row:focus-visible { outline: 1px dotted var(--op-field-ink); outline-offset: -2px; }
.op-log-main { display: grid; gap: 2px; flex: 1; min-width: 0; }
.op-log-line { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.op-log-dot { flex-shrink: 0; width: 7px; height: 7px; align-self: center; }
.op-log-id { flex-shrink: 0; color: #9fb3c6; }
.op-log-title { font-weight: 600; color: #f4f1e4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-log-note { color: #9fb3c6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.op-log-meta { flex-shrink: 0; display: grid; justify-items: end; gap: 1px; width: 170px; text-align: right; }
.op-log-who { color: #f4f1e4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.op-log-dim { color: #7d8fa3; font-size: 11px; }
.op-log-commit { align-items: center; }
.op-log-clean { color: #6ee36e; }
.op-log-overview { display: grid; gap: 8px; padding: 8px 8px 10px; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.op-log-totals { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.op-log-total { font-size: 14px; font-weight: 600; color: #f4f1e4; }
.op-log-totals .op-log-lines { font-size: 14px; }
.op-log-kinds { display: flex; flex-wrap: wrap; gap: 4px 14px; color: #c7d3df; }
.op-log-kind { display: inline-flex; align-items: center; gap: 6px; }
.op-log-kind-dot { width: 7px; height: 7px; }
.op-log-folders { display: grid; gap: 2px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06); }
.op-log-folder { display: flex; align-items: baseline; gap: 12px; }
.op-log-folder .op-log-dim, .op-log-folder.op-log-dim > span:nth-child(2) { flex-shrink: 0; width: 70px; text-align: right; }
.op-log-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-log-hash { flex-shrink: 0; width: 80px; color: #f5d547; }
.op-log-lines { flex-shrink: 0; min-width: 90px; text-align: right; font-variant-numeric: tabular-nums; }
.op-log-add { color: #6ee36e; }
.op-log-del { color: #e5484d; }

/* The Issues tab: every open issue, as a board */
.op-issues { display: flex; flex-direction: column; min-height: 0; }
.op-issues-repos {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.op-issues-repo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  font: inherit;
  font-size: 11px;
  color: #c7d3df;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 999px;
  cursor: pointer;
}
.op-issues-repo[aria-pressed="true"] { color: #f4f1e4; background: rgba(245,213,71,0.16); border-color: #f5d547; }
.op-issues-repo-count { color: #9fb3c6; font-variant-numeric: tabular-nums; }
.op-issues-problems { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.08); }
.op-issues-problem { color: #ff8a80; font-size: 11px; }
.op-issues-body { overflow-y: auto; max-height: min(620px, calc(100vh - 300px)); }
/* The columns are wide enough for their cards to sit side by side, and the board scrolls across */
.op-issues-columns { display: grid; grid-template-columns: repeat(5, minmax(260px, 1fr)); gap: 8px; padding: 8px; align-items: start; }
.op-issues-column { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.op-issues-column-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 4px 6px;
  font-size: 12px;
  font-weight: 700;
  color: #f4f1e4;
  background: var(--op-field);
  border-top: 3px solid #9aa0a6;
}
/* The cards sit side by side within a column, as many as fit */
.op-issues-cards { display: grid; gap: 6px; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); align-items: start; }
.op-issues-empty { padding: 6px; text-align: center; opacity: 0.4; }
.op-issues-card {
  display: grid;
  gap: 3px;
  padding: 6px;
  font-size: 11px;
  line-height: 1.35;
  color: inherit;
  text-align: left;
  background: var(--op-field);
  border: 1px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
}
.op-issues-card-top { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.op-issues-repo-name { margin-left: auto; color: #7d8fa3; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-issues-card-title {
  font-weight: 600;
  color: #f4f1e4;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.op-issues-card-open {
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  cursor: pointer;
}
.op-issues-card-open:hover .op-issues-card-title { text-decoration: underline; }
.op-issues-card-open:focus-visible { outline: 1px dotted var(--op-field-ink); outline-offset: 1px; }
.op-issues-card-meta { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 10px; color: #9fb3c6; }
.op-issues-working { color: #60a5fa; }
.op-issues-labels { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.op-issues-label { padding: 0 5px; font-size: 9px; color: #c7d3df; background: rgba(255,255,255,0.07); border-radius: 999px; }
.op-issues-group { display: grid; gap: 6px; padding: 8px; }
.op-issues-group-title { display: flex; align-items: baseline; gap: 10px; margin: 0; font-size: 13px; color: #f5d547; }
.op-issues-group .op-issues-cards { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
/* The form for a new issue */
.op-issue-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(4, 8, 14, 0.7);
}
.op-issue-form {
  display: grid;
  gap: 10px;
  width: min(520px, 100%);
  padding: 16px;
  font-family: var(--op-font);
  font-size: 13px;
  color: var(--op-field-ink);
  background: var(--op-field);
  border: 2px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}
.op-issue-title { margin: 0; font-size: 15px; font-weight: 700; color: #f5d547; }
.op-issue-field { display: grid; gap: 3px; }
.op-issue-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.75; }
.op-issue-input {
  width: 100%;
  padding: 6px 8px;
  font-family: inherit;
  font-size: 13px;
  color: var(--op-field-ink);
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
  border-radius: 0;
}
.op-issue-input:focus { outline: 1px dotted var(--op-field-ink); outline-offset: 1px; }
.op-issue-textarea { resize: vertical; min-height: 70px; font-family: inherit; }
.op-issue-error { padding: 6px 8px; font-size: 12px; color: #ff8a80; background: rgba(248, 113, 113, 0.1); }
.op-issue-empty { margin: 0; opacity: 0.75; line-height: 1.5; }
.op-issue-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }

@media (max-width: 640px) {
  .op-log-meta { width: 110px; }
  .op-log-hash { width: 64px; }
  .op-issues-columns { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
}
.op-toasts {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none;
}
.op-toast {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  width: 300px;
  padding: 8px 10px 9px 8px;
  font-family: var(--op-font);
  font-size: 12px;
  line-height: 1.4;
  text-align: left;
  color: #e5e7eb;
  background: rgba(10, 14, 22, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-left: 3px solid #6ee36e;
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  cursor: pointer;
  pointer-events: auto;
  animation: op-toast-life 6s ease forwards;
}
.op-toast:hover { animation-play-state: paused; border-color: rgba(255, 255, 255, 0.32); border-left-color: #c8ffd4; }
.op-toast:focus-visible { outline: 1px dotted #e5e7eb; outline-offset: 2px; }
@keyframes op-toast-life {
  0% { opacity: 0; transform: translateY(-10px); }
  5% { opacity: 1; transform: none; }
  80% { opacity: 1; transform: none; }
  100% { opacity: 0; transform: translateY(-4px); }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes op-toast-life { 0% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
}
.op-toast-badge {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  font-size: 12px;
  font-weight: 700;
  color: #0a0e16;
  background: #6ee36e;
  border-radius: 3px;
}
.op-toast[data-kind="decision"] { border-left-color: #22d3ee; }
.op-toast[data-kind="decision"]:hover { border-left-color: #a5f3fc; }
.op-toast[data-kind="decision"] .op-toast-badge { background: #22d3ee; }
.op-toast[data-kind="decision"] .op-toast-head strong { color: #22d3ee; }
.op-toast[data-kind="login"] { border-left-color: #fbbf24; }
.op-toast[data-kind="login"]:hover { border-left-color: #fde68a; }
.op-toast[data-kind="login"] .op-toast-badge { background: #fbbf24; }
.op-toast[data-kind="login"] .op-toast-head strong { color: #fbbf24; }
.op-toast-body { display: grid; gap: 1px; min-width: 0; }
.op-toast-head { display: flex; gap: 6px; align-items: baseline; }
.op-toast-head strong { color: #6ee36e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.op-toast-id { color: #94a3b8; font-size: 11px; }
.op-toast-title { color: #f9fafb; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.op-toast-by { color: #94a3b8; font-size: 11px; }
.op-timeline { position: relative; gap: 6px; padding: 2px 8px; cursor: default; }
.op-timeline svg { display: block; }
.op-timeline-bar { fill: #6ee36e; }
.op-timeline-empty { fill: var(--op-lo); }
.op-timeline-bar[data-hovered] { fill: #c8ffd4; }
.op-timeline-empty[data-hovered] { fill: var(--op-hi); }
.op-timeline-total { min-width: 2ch; text-align: right; font-weight: 600; }
.op-timeline-tip {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  width: 210px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.45;
  color: #e5e7eb;
  background: rgba(10, 14, 22, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.op-timeline-tip-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.op-timeline-tip-head strong { color: #f9fafb; font-size: 13px; }
.op-timeline-tip-big { color: #6ee36e; font-size: 16px; font-weight: 700; }
.op-timeline-tip-row { display: flex; justify-content: space-between; gap: 8px; }
.op-timeline-tip-count { color: #6ee36e; font-weight: 600; }
.op-timeline-tip-count[data-zero] { color: #94a3b8; }
.op-timeline-tip-dim { color: #94a3b8; }
.op-timeline-tip-foot { margin-top: 6px; padding-top: 5px; border-top: 1px solid rgba(255, 255, 255, 0.1); color: #64748b; font-size: 11px; }
.op-lamp { flex-shrink: 0; width: 7px; height: 7px; background: #64748b; }
.op-lamp[data-state="live"], .op-lamp[data-state="running"] { background: #6ee36e; }
.op-lamp[data-state="idle"] { background: #94a3b8; }
.op-lamp[data-state="paused"] { background: #f5d547; }
.op-lamp[data-state="error"] { background: #e5484d; }
.op-lamp[data-state="decision"] { background: #f97316; box-shadow: 0 0 5px #f97316; }
.op-lamp[data-state="connecting"] { background: #f5d547; }
.op-lamp[data-state="offline"] { background: #e5484d; }
.op-body {
  padding: 6px;
  border-top: 2px solid var(--op-hi);
}
.op-viewport {
  border: 2px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
}
.op-button {
  padding: 4px 10px;
  font-family: var(--op-font);
  font-size: 13px;
  font-weight: 600;
  color: var(--op-ink);
  background: var(--op-face);
  border: 2px solid;
  border-color: var(--op-hi) var(--op-lo) var(--op-lo) var(--op-hi);
  border-radius: 0;
  cursor: pointer;
  white-space: nowrap;
}
.op-button-icon { min-width: 40px; padding: 1px 8px 2px; font-size: 18px; line-height: 1.2; }
.op-button-icon:active { padding: 2px 7px 1px 9px; }
.op-button-icon[aria-pressed="false"] > span { filter: grayscale(0.7); opacity: 0.7; }
.op-cam-arrow {
  position: absolute;
  top: 50%;
  z-index: 2;
  transform: translateY(-50%);
  width: 32px;
  height: 56px;
  padding: 0;
  font-size: 14px;
  opacity: 0.8;
  transition: opacity 80ms, background 80ms;
}
.op-cam-arrow[data-side="left"] { left: 10px; }
.op-cam-arrow[data-side="right"] { right: 10px; }
.op-cam-arrow-badge { position: absolute; top: -26px; left: 50%; transform: translateX(-50%); pointer-events: none; line-height: 0; }
.op-cam-arrow:hover { opacity: 1; background: var(--op-hi); }
.op-cam-arrow:active { padding: 1px 0 0 1px; }
.op-button-toggle { display: flex; align-items: center; gap: 6px; }
.op-button-new { transition: background 80ms, filter 80ms; }
.op-button-new:hover:not(:active) { background: var(--op-hi); filter: brightness(1.06); }
.op-button:active { border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo); padding: 5px 9px 3px 11px; }
.op-button[aria-pressed="true"] {
  background: var(--op-lo);
  color: var(--op-title-ink);
  border-color: var(--op-deep) var(--op-hi) var(--op-hi) var(--op-deep);
}
.op-stats { display: grid; gap: 8px; }
.op-stats-top { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.op-segment { display: flex; gap: 2px; }
.op-stats-totals { display: flex; flex-wrap: wrap; gap: 6px; }
.op-readout {
  display: grid;
  min-width: 108px;
  padding: 3px 8px 4px;
  background: var(--op-field);
  border: 1px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
}
.op-readout-label { font-size: 11px; color: #9fb3c6; }
.op-readout-value { font-size: 20px; font-weight: 600; color: #f5d547; font-variant-numeric: tabular-nums; }
.op-stats { position: relative; }
.op-list {
  overflow-x: auto;
  background: var(--op-field);
  border: 2px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
  color: var(--op-field-ink);
  font-size: 13px;
}
.op-list-row {
  display: grid;
  grid-template-columns: minmax(170px, 1.6fr) minmax(64px, 0.3fr) minmax(112px, 0.6fr) minmax(120px, 0.8fr) minmax(76px, 0.6fr) minmax(118px, 0.6fr) minmax(120px, 1.2fr) minmax(70px, 0.6fr);
  align-items: center;
}
.op-list[data-mode="leisure"] .op-list-row {
  grid-template-columns: minmax(170px, 1.6fr) minmax(64px, 0.3fr) minmax(112px, 0.6fr) repeat(6, minmax(112px, 0.6fr));
}
/* No agent can be started: the Run column is left out */
.op-list[data-run="hidden"] .op-list-row {
  grid-template-columns: minmax(170px, 1.6fr) minmax(112px, 0.6fr) minmax(120px, 0.8fr) minmax(76px, 0.6fr) minmax(118px, 0.6fr) minmax(120px, 1.2fr) minmax(70px, 0.6fr);
}
.op-list[data-run="hidden"][data-mode="leisure"] .op-list-row {
  grid-template-columns: minmax(170px, 1.6fr) minmax(112px, 0.6fr) repeat(6, minmax(112px, 0.6fr));
}
.op-list[data-mode="leisure"] :is(.op-list-head, .op-list-body) { min-width: 1100px; }
.op-list-head, .op-list-body { min-width: 950px; }
.op-list-head { position: sticky; top: 0; z-index: 1; }
.op-status-cell { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.op-run-cell { display: flex; align-items: center; justify-content: flex-start; }
.op-run-button {
  width: 30px;
  height: 26px;
  padding: 0;
  font-family: var(--op-font);
  font-size: 11px;
  font-weight: 700;
  color: #1d4a26;
  background: #7fd08c;
  border: 2px solid;
  border-color: #b6e3bb #3f8f4f #3f8f4f #b6e3bb;
  border-radius: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 80ms, filter 80ms;
}
.op-run-button:hover:not(:disabled) { background: #b6e3bb; }
.op-run-button:active:not(:disabled) { border-color: #3f8f4f #b6e3bb #b6e3bb #3f8f4f; }
.op-run-button:disabled {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.35);
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
  cursor: not-allowed;
}
.op-run-button:focus-visible { outline: 1px dotted #b6e3bb; outline-offset: 1px; }
.op-colhead {
  padding: 3px 6px;
  font-family: var(--op-font);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  color: var(--op-ink);
  background: var(--op-face);
  border: 1px solid;
  border-color: var(--op-hi) var(--op-lo) var(--op-lo) var(--op-hi);
  border-radius: 0;
  cursor: pointer;
  white-space: nowrap;
}
.op-colhead:nth-child(n + 3) { text-align: right; }
.op-colhead:active { border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo); }
.op-list-body { max-height: min(560px, calc(100vh - 330px)); min-height: 200px; overflow-y: auto; transition: opacity 120ms; }
.op-list-body .op-list-row { min-height: 54px; padding: 0 6px; gap: 0 12px; }
.op-list-body .op-list-row:nth-child(even) { background: rgba(255,255,255,0.04); }
.op-list-body .op-list-row:hover { background: rgba(245,213,71,0.1); }
.op-list-row[data-idle] { opacity: 0.45; }
.op-model-cell { min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; opacity: 0.85; }
.op-list-empty { padding: 16px; text-align: center; opacity: 0.7; }
.op-link {
  justify-self: start;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
  text-align: left;
}
.op-agent { display: flex; align-items: center; gap: 8px; min-width: 0; }
.op-agent-text { display: grid; min-width: 0; line-height: 1.2; }
.op-agent-name { overflow: hidden; text-overflow: ellipsis; }
.op-agent-room { font-size: 11px; color: #9fb3c6; overflow: hidden; text-overflow: ellipsis; }
/* A 2x sprite cropped at the waist, like a portrait. */
.op-avatar {
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  overflow: hidden;
  width: 38px;
  height: 46px;
  background: rgba(255,255,255,0.06);
  border: 1px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
}
.op-avatar > * { flex-shrink: 0; margin-top: 2px; }
.op-link:hover { color: #f5d547; text-decoration: underline; }
.op-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.op-bar-cell { position: relative; display: flex; align-items: center; justify-content: flex-end; height: 16px; }
.op-bar {
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 3px;
  max-width: calc(100% - 64px);
  background: #3f8f4f;
  border: 1px solid;
  border-color: #7fd08c #1d4a26 #1d4a26 #7fd08c;
}
.op-bar[style*="width: 0%"] { display: none; }
.op-bar-label { position: relative; }
.op-stats-note { font-size: 11px; opacity: 0.75; }
.op-highscores { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; transition: opacity 120ms; }
.op-highscore {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 4px 16px;
  padding: 4px 8px 6px;
  background: var(--op-field);
  border: 1px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
  color: var(--op-field-ink);
  font-size: 12px;
}
.op-highscore > .op-readout-label { flex-basis: 100%; }
.op-highscore-unit { font-size: 12px; font-weight: 400; color: #9fb3c6; }
.op-highscore-empty { padding: 8px 0; opacity: 0.7; }
.op-highscore-rest { flex: 1; min-width: 140px; margin: 0; padding-left: 20px; }
.op-highscore-rest li { display: list-item; }
.op-highscore-rest li > * { display: inline-block; }
.op-highscore-name { max-width: calc(100% - 56px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.op-highscore-rest .op-num { float: right; }
/* A window button in the title bar, like a desktop window's maximise button */
/* A window over the page, e.g. an agent's character picker */
.op-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(5, 8, 14, 0.6);
}
.op-dialog { width: min(760px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; }
.op-dialog-body { padding: 12px; overflow: auto; color: var(--op-field-ink); background: var(--op-field); border-top: 2px solid var(--op-hi); }
/* An agent's avatar in the Agents list opens their character picker */
.op-avatar-button { padding: 0; cursor: pointer; }
.op-avatar-button:hover { background: rgba(245,213,71,0.2); border-color: #f5d547; }
.op-avatar-button:focus-visible { outline: 1px dotted #f5d547; outline-offset: 1px; }
.op-titlebar-actions { display: flex; gap: 4px; flex-shrink: 0; }
.op-titlebar-button {
  flex-shrink: 0;
  width: 22px;
  height: 20px;
  padding: 0;
  display: grid;
  place-items: center;
  color: var(--op-ink);
  background: var(--op-face);
  border: 1px solid;
  border-color: var(--op-hi) var(--op-deep) var(--op-deep) var(--op-hi);
  cursor: pointer;
}
.op-titlebar-button:hover { background: var(--op-hi); }
.op-titlebar-button:active { border-color: var(--op-deep) var(--op-hi) var(--op-hi) var(--op-deep); }
.op-titlebar-button:focus-visible { outline: 1px dotted var(--op-title-ink); outline-offset: 1px; }
.op-titlebar-button > span { font-size: 11px; line-height: 1; }
.op-close {
  width: 18px;
  height: 16px;
  padding: 0;
  display: grid;
  place-items: center;
  font-family: var(--op-font);
  font-size: 12px;
  line-height: 1;
  color: #fff;
  background: #b23a3a;
  border: 1px solid;
  border-color: #e88 #5a1515 #5a1515 #e88;
  cursor: pointer;
}
/* Settings tab: the office setup form, scrolling within the window like the Agents list */
.op-settings { max-height: min(720px, calc(100vh - 240px)); overflow-y: auto; padding-right: 4px; }
:is(.op-window:fullscreen, .op-window-fill) .op-settings { max-height: none; flex: 1; }
.op-settings code { font-family: var(--op-font); font-size: 11px; background: var(--op-deep); padding: 0 3px; }
.op-settings-characters {
  display: grid;
  gap: 12px;
  padding: 14px;
  background: var(--op-field);
  color: var(--op-field-ink);
  border: 2px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
}
.op-settings-characters h3 { margin: 0; font-size: 14px; font-weight: 700; color: #f5d547; }
/* About tab: the llama on its little paddock, beside the credits */
.op-about {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 16px;
  background: var(--op-field);
  color: var(--op-field-ink);
  border: 2px solid;
  border-color: var(--op-lo) var(--op-hi) var(--op-hi) var(--op-lo);
}
.op-about-stage {
  display: grid;
  justify-items: center;
  align-content: start;
  flex: 0 0 auto;
  padding: 12px 18px;
  background: #223041;
  border: 2px solid;
  border-color: var(--op-deep) var(--op-lo) var(--op-lo) var(--op-deep);
  transition: background 120ms steps(2, jump-none);
}
/* The stage brightens while it's squawking, so the click lands even if the frames blur past */
.op-about-stage:has(.op-about-llama[data-squealing]) { background: #2d425a; }
.op-about-llama {
  display: grid;
  place-items: end center;
  padding: 0;
  background: none;
  border: 0;
  cursor: pointer;
  line-height: 0;
  filter: drop-shadow(0 2px 0 rgba(16, 24, 32, 0.5));
}
.op-about-llama:hover { filter: drop-shadow(0 2px 0 rgba(16, 24, 32, 0.5)) brightness(1.08); }
.op-about-llama:active { transform: translateY(2px); }
.op-about-llama:focus-visible { outline: 1px dotted var(--op-field-ink); outline-offset: 5px; }

.op-about-copy {
  display: grid;
  gap: 10px;
  align-content: start;
  flex: 1 1 260px;
  min-width: 0;
}
.op-about-copy p { margin: 0; font-size: 13px; line-height: 1.6; }
.op-about-copy h3 { margin: 0; font-size: 15px; font-weight: 700; color: #f5d547; }
.op-about-version { font-size: 12px; font-weight: 400; color: #9fb3c6; }
.op-about-tagline { font-size: 14px; }
.op-about-link { color: #6ee36e; text-decoration: underline; }
.op-about-link:hover { color: #c8ffd4; }
.op-about-link[data-coming] { color: #9fb3c6; text-decoration: none; }
.op-about-credits { display: grid; gap: 6px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.08); }
.op-about-credits h4 { margin: 0; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #9fb3c6; }
.op-about-credits ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: 12px; line-height: 1.5; }
.op-about-credits li::before { content: "· "; color: #7d8fa3; }
`;

/** The window chrome's style sheet and pixel font; render once inside `.op-root`. */
export function GameUiStyles() {
  useEffect(() => {
    if (document.getElementById(FONT_LINK_ID)) return;
    const link = document.createElement("link");
    link.id = FONT_LINK_ID;
    link.rel = "stylesheet";
    link.href = FONT_HREF;
    document.head.appendChild(link);
  }, []);
  return <style>{CSS}</style>;
}

export function GameTab({
  icon,
  label,
  title,
  pressed,
  onClick,
  badge,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  pressed: boolean;
  onClick: () => void;
  /** Pinned over the tab's top-right corner, e.g. to flag something needing attention */
  badge?: ReactNode;
}) {
  return (
    <button type="button" className="op-tab" aria-pressed={pressed} title={title} onClick={onClick}>
      <span className="op-tab-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
      {badge ? <span className="op-tab-badge">{badge}</span> : null}
    </button>
  );
}

/** A sprite (rows of colours, "" for clear) drawn as crisp square pixels at a whole-number scale */
export function PixelSprite({ sprite, scale = 2 }: { sprite: string[][]; scale?: number }) {
  const width = Math.max(0, ...sprite.map((row) => row.length));
  // Runs of one colour collapse into a single rect, so a big sprite that animates — the About tab's
  // 32x64 llama — costs a couple hundred elements instead of two thousand
  const runs = sprite.flatMap((row, y) => {
    const out: Array<{ x: number; y: number; w: number; fill: string }> = [];
    let x = 0;
    while (x < row.length) {
      const color = row[x];
      let end = x;
      while (end + 1 < row.length && row[end + 1] === color) end++;
      if (color) out.push({ x, y, w: end - x + 1, fill: color });
      x = end + 1;
    }
    return out;
  });
  return (
    <svg
      className="op-pixel-sprite"
      width={width * scale}
      height={sprite.length * scale}
      viewBox={`0 0 ${width} ${sprite.length}`}
      aria-hidden="true"
    >
      {runs.map((run) => (
        <rect key={`${run.x},${run.y}`} x={run.x} y={run.y} width={run.w} height={1} fill={run.fill} />
      ))}
    </svg>
  );
}

export function GameStatus({ state }: { state: "live" | "connecting" | "offline" }) {
  return (
    <div className="op-status">
      <span className="op-lamp" data-state={state} />
      {state === "live" ? "Live" : state === "connecting" ? "Connecting" : "Offline"}
    </div>
  );
}
