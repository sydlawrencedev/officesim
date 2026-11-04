import type { HarnessIcon } from "../../../src/ui/hostExtensions";
import aider from "./icons/aider.png";
import claude from "./icons/claude.png";
import codex from "./icons/codex.png";
import cursor from "./icons/cursor.png";
import gemini from "./icons/gemini.png";
import goose from "./icons/goose.png";
import hermes from "./icons/hermes.png";
import opencode from "./icons/opencode.png";
import orchestrator from "./icons/orchestrator.png";
import paperclip from "./icons/paperclip.png";

/*
 * Each agent source's icon, scaled to 64px: the harness's own favicon (claude.ai, opencode.ai,
 * gemini.google.com, cursor.com, aider.chat, nousresearch.com for Hermes, Goose's docs, Paperclip's
 * local server), or its maker's GitHub avatar where the site blocks downloads (OpenAI for Codex,
 * Untrivial for Agent Orchestrator).
 */

const BY_SOURCE: Record<string, HarnessIcon> = {
  claude: { src: claude, label: "Claude Code" },
  codex: { src: codex, label: "Codex" },
  opencode: { src: opencode, label: "OpenCode" },
  gemini: { src: gemini, label: "Gemini CLI" },
  cursor: { src: cursor, label: "Cursor CLI" },
  goose: { src: goose, label: "Goose" },
  aider: { src: aider, label: "Aider" },
  hermes: { src: hermes, label: "Hermes" },
  orchestrator: { src: orchestrator, label: "Agent Orchestrator" },
  paperclip: { src: paperclip, label: "Paperclip" },
};

export function iconFor(source: string | null | undefined): HarnessIcon | null {
  return (source && BY_SOURCE[source]) || null;
}
