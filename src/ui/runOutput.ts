import { useEffect, useState } from "react";

/*
 * What a working agent has been saying and doing lately, read from the tail of its live run log
 * (Paperclip's /heartbeat-runs/:id/log). The log is ndjson of adapter output chunks; each adapter
 * streams its own JSON events, so the common ones are understood here: Claude (assistant messages
 * with text/tool_use blocks), Codex (item.completed agent_message/command_execution) and OpenCode
 * (text and tool_use parts).
 */

export type RunOutput = {
  /** The agent's latest message, tidied and shortened. */
  message: string | null;
  /** What it has done since that message (e.g. "Ran npm test"), oldest first, at most a few. */
  actions: string[];
};

/** Actions shown after the latest message; agents that only call tools get just these. */
const MAX_ACTIONS = 3;

/** How much of the log to read at a time, from the end; enough for a few messages between tool calls. */
const TAIL_BYTES = 192 * 1024;
/** Chunks to read back through when big tool outputs push the last message further up the log. */
const MAX_CHUNKS = 4;
const MESSAGE_MAX_CHARS = 280;
const ACTION_MAX_CHARS = 90;
/** How long a fetched summary is reused before hovering again re-reads the log. */
const REFRESH_MS = 10_000;

type Event = { kind: "message" | "action"; text: string };

function tidy(text: string, max: number): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(#{1,6}|>|[-*]\s)\s*/gm, "")
    .replace(/[*`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

/** A tool call as a short phrase, from its name and input. */
function describeTool(tool: string, input: Record<string, unknown> | undefined, title?: string | null): string {
  const name = tool.toLowerCase();
  const command = str(input?.command) ?? str(input?.cmd);
  const path = str(input?.file_path) ?? str(input?.filePath) ?? str(input?.path);
  const pattern = str(input?.pattern) ?? str(input?.query);
  const url = str(input?.url);
  // Drop the "cd somewhere &&" most commands start with
  if (command) return `Ran ${command.split("\n")[0].replace(/^cd\s+\S+\s*&&\s*/, "")}`;
  if (/edit|write|patch/.test(name) && path) return `Edited ${shortPath(path)}`;
  if (/read|view/.test(name) && path) return `Read ${shortPath(path)}`;
  if (/grep|glob|search|find/.test(name) && pattern) return `Searched for ${pattern}`;
  if (/fetch|web/.test(name) && (url || pattern)) return `Looked up ${url ?? pattern}`;
  if (title) return title;
  if (path) return `${tool} ${shortPath(path)}`;
  return `Used ${tool}`;
}

/** The message/action events in one adapter JSON event. */
function eventsFrom(event: Record<string, unknown>): Event[] {
  const type = event.type;
  // OpenCode
  const part = event.part as Record<string, unknown> | undefined;
  if (type === "text" && part && str(part.text)) return [{ kind: "message", text: part.text as string }];
  if (type === "tool_use" && part && typeof part.tool === "string") {
    const state = part.state as Record<string, unknown> | undefined;
    return [{ kind: "action", text: describeTool(part.tool, state?.input as Record<string, unknown>, str(state?.title)) }];
  }
  // Claude
  if (type === "assistant") {
    const content = (event.message as { content?: unknown })?.content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block: Record<string, unknown>): Event[] => {
      if (block?.type === "text" && str(block.text)) return [{ kind: "message", text: block.text as string }];
      if (block?.type === "tool_use" && typeof block.name === "string") {
        return [{ kind: "action", text: describeTool(block.name, block.input as Record<string, unknown>) }];
      }
      return [];
    });
  }
  // Codex
  if (type === "item.completed") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "agent_message" && str(item.text)) return [{ kind: "message", text: item.text as string }];
    if (item?.type === "command_execution" && str(item.command)) return [{ kind: "action", text: describeTool("shell", { command: item.command }) }];
    if (item?.type === "file_change" && Array.isArray(item.changes) && item.changes.length > 0) {
      const path = str((item.changes[0] as Record<string, unknown>)?.path);
      return [{ kind: "action", text: path ? `Edited ${shortPath(path)}` : "Edited files" }];
    }
  }
  return [];
}

/** The latest message, and the latest actions since it, from a chunk of ndjson run log. */
export function summarizeRunLog(content: string): RunOutput {
  let message: string | null = null;
  let actions: string[] = [];
  for (const line of content.split("\n")) {
    let entry: { stream?: string; chunk?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first line is usually cut off by the byte offset
    }
    if (entry.stream !== "stdout" || typeof entry.chunk !== "string") continue;
    for (const raw of entry.chunk.split("\n")) {
      if (!raw.startsWith("{")) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const found of eventsFrom(event)) {
        if (found.kind === "message") {
          message = found.text;
          actions = [];
        } else {
          actions.push(found.text);
        }
      }
    }
  }
  return {
    message: message ? tidy(message, MESSAGE_MAX_CHARS) : null,
    actions: actions.slice(-MAX_ACTIONS).map((action) => tidy(action, ACTION_MAX_CHARS)),
  };
}

const cache = new Map<string, { output: RunOutput; fetchedAt: number }>();
const inFlight = new Map<string, Promise<RunOutput | null>>();

async function readLog(runId: string, offset: number, limitBytes: number): Promise<string | null> {
  const params = new URLSearchParams({ offset: String(offset), limitBytes: String(limitBytes) });
  try {
    const response = await fetch(`/api/heartbeat-runs/${encodeURIComponent(runId)}/log?${params}`, { credentials: "include" });
    if (!response.ok) return null;
    const body = (await response.json()) as { content?: unknown };
    return typeof body.content === "string" ? body.content : null;
  } catch {
    return null;
  }
}

async function fetchRunOutput(runId: string, logBytes: number | null | undefined): Promise<RunOutput | null> {
  let end = Math.max(0, logBytes ?? 0);
  // Actions from later in the log than the chunk being read
  let later: string[] = [];
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    const offset = Math.max(0, end - TAIL_BYTES);
    // The first read runs past the known size: the log keeps growing after that was recorded.
    const content = await readLog(runId, offset, chunk === 0 ? TAIL_BYTES * 2 : end - offset);
    if (content === null) return chunk === 0 ? null : { message: null, actions: later };
    const found = summarizeRunLog(content);
    const actions = [...found.actions, ...later].slice(-MAX_ACTIONS);
    if (found.message || actions.length >= MAX_ACTIONS || offset === 0) return { message: found.message, actions };
    later = actions;
    // Next read ends where this one's first whole line starts, so the line cut in two is read whole
    const firstBreak = content.indexOf("\n");
    end = offset + (firstBreak < 0 ? 0 : new TextEncoder().encode(content.slice(0, firstBreak + 1)).length);
  }
  return { message: null, actions: later };
}

/** The live output summary of a running run, refreshed while the component showing it is mounted. */
export function useRunOutput(runId: string | null, logBytes: number | null | undefined): RunOutput | null {
  const [output, setOutput] = useState<RunOutput | null>(() => (runId ? cache.get(runId)?.output ?? null : null));
  useEffect(() => {
    if (!runId) {
      setOutput(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      const cached = cache.get(runId);
      if (cached) setOutput(cached.output);
      if (cached && Date.now() - cached.fetchedAt < REFRESH_MS) return;
      let request = inFlight.get(runId);
      if (!request) {
        request = fetchRunOutput(runId, logBytes).finally(() => inFlight.delete(runId));
        inFlight.set(runId, request);
      }
      void request.then((result) => {
        if (!result) return;
        cache.set(runId, { output: result, fetchedAt: Date.now() });
        if (!cancelled) setOutput(result);
      });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, logBytes]);
  return output;
}
