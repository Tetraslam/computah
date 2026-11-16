import type { Agent, AgentEvent } from "./types.js";

type Json = Record<string, unknown>;

function parseJson(line: string): Json | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === "object" ? (value as Json) : null;
  } catch {
    return null;
  }
}

const obj = (value: unknown): Json =>
  value && typeof value === "object" ? (value as Json) : {};
const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** A short human label for a tool call: the file it touched or the command it ran. */
export function toolDetail(input: unknown): string | undefined {
  const fields = obj(input);
  for (const key of [
    "file_path",
    "filePath",
    "path",
    "command",
    "pattern",
    "query",
    "url",
    "description",
  ]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) {
      const oneLine = value.replace(/\s+/g, " ").trim();
      return oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine;
    }
  }
  return undefined;
}

export interface AgentOptions {
  /** Model to pass through, in the agent's own format. */
  model?: string;
  /** Extra arguments appended to the command. */
  args?: string[];
}

/** Claude Code: `claude -p --output-format stream-json`. */
export function claude(options: AgentOptions = {}): Agent {
  return {
    name: "claude",
    command: (prompt) => ({
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        ...(options.model ? ["--model", options.model] : []),
        ...(options.args ?? []),
      ],
      stdin: prompt,
    }),
    parse(line) {
      const message = parseJson(line);
      if (!message) return [];
      if (message.type === "assistant") {
        const events: AgentEvent[] = [];
        const content = obj(message.message).content;
        for (const block of Array.isArray(content) ? content : []) {
          const part = obj(block);
          if (part.type === "text" && str(part.text).trim())
            events.push({ type: "text", text: str(part.text) });
          if (part.type === "tool_use") {
            events.push({
              type: "tool",
              name: str(part.name) || "tool",
              detail: toolDetail(part.input),
            });
          }
        }
        return events;
      }
      if (message.type === "result") {
        if (message.is_error)
          return [
            {
              type: "error",
              message: str(message.result) || "The agent reported an error.",
            },
          ];
        return [{ type: "result", text: str(message.result) }];
      }
      return [];
    },
  };
}

/** OpenCode: `opencode run --format json`. */
export function opencode(options: AgentOptions = {}): Agent {
  return {
    name: "opencode",
    command: (prompt) => ({
      command: "opencode",
      args: [
        "run",
        "--format",
        "json",
        "--auto",
        "--archived",
        ...(options.model ? ["--model", options.model] : []),
        ...(options.args ?? []),
        prompt,
      ],
    }),
    parse(line) {
      const message = parseJson(line);
      if (!message) return [];
      const part = obj(message.part);
      if (message.type === "text" && str(part.text).trim())
        return [{ type: "text", text: str(part.text) }];
      if (message.type === "tool_use") {
        const state = obj(part.state);
        return [
          {
            type: "tool",
            name: str(part.tool) || "tool",
            detail: toolDetail(state.input),
          },
        ];
      }
      if (message.type === "error") {
        const error = obj(message.error);
        return [
          {
            type: "error",
            message:
              str(obj(error.data).message) ||
              str(error.name) ||
              "The agent reported an error.",
          },
        ];
      }
      return [];
    },
  };
}

/** Codex: `codex exec --json`. */
export function codex(options: AgentOptions = {}): Agent {
  return {
    name: "codex",
    command: (prompt) => ({
      command: "codex",
      args: [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        ...(options.model ? ["--model", options.model] : []),
        ...(options.args ?? []),
        "-",
      ],
      stdin: prompt,
    }),
    parse(line) {
      const message = parseJson(line);
      if (!message) return [];
      const item = obj(message.item);
      if (
        message.type === "item.completed" &&
        item.type === "agent_message" &&
        str(item.text).trim()
      ) {
        return [{ type: "text", text: str(item.text) }];
      }
      if (
        message.type === "item.started" &&
        item.type === "command_execution"
      ) {
        return [
          {
            type: "tool",
            name: "shell",
            detail: toolDetail({ command: item.command }),
          },
        ];
      }
      if (message.type === "item.completed" && item.type === "file_change") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return changes.map((change) => ({
          type: "tool" as const,
          name: "edit",
          detail: str(obj(change).path) || undefined,
        }));
      }
      if (message.type === "error" || message.type === "turn.failed") {
        return [
          {
            type: "error",
            message:
              str(message.message) ||
              str(obj(message.error).message) ||
              "The agent reported an error.",
          },
        ];
      }
      return [];
    },
  };
}

export const agents = { claude, opencode, codex };
export type AgentName = keyof typeof agents;
