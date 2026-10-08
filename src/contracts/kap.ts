/** KAP/1: bounded textual LLM wire format. Host still validates tools and completion. */
export type KAPAction = "TOOL" | "FINAL" | "WORKSPACE" | "TOOLS";
export interface KAPMessage {
  action: "use_tool" | "final_response" | "request_workspace" | "request_tools";
  tool: string | null;
  tool_input: Record<string, unknown> | null;
  content: string | Record<string, unknown> | null;
  reasoning_summary: string;
  loop: null;
}

export class KAPError extends Error {
  constructor(message: string) { super(message); this.name = "KAPError"; }
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_BYTES = 64 * 1024;
const MAX_LINES = 3000;
const MAX_DEPTH = 20;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function pathParts(path: string): string[] {
  const parts = path.split(".");
  if (!parts.length || parts.length > MAX_DEPTH || path.length > 512
    || parts.some((part) => !(KEY.test(part) || /^(0|[1-9][0-9]{0,4})$/.test(part)) || FORBIDDEN.has(part))) {
    throw new KAPError("Invalid field path: " + path);
  }
  return parts;
}

function assign(root: Record<string, unknown>, path: string, value: unknown, assigned: Set<string>): void {
  if (assigned.has(path)) throw new KAPError("Duplicate field: " + path);
  const parts = pathParts(path);
  let parent: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const key = Array.isArray(parent) ? Number(part) : part;
    if (Array.isArray(parent) && (!Number.isInteger(key) || key < 0 || key > 1024)) throw new KAPError("Invalid array index");
    let child = (parent as Record<string | number, unknown>)[key];
    if (child === undefined) {
      child = /^[0-9]+$/.test(parts[i + 1]!) ? [] : Object.create(null);
      (parent as Record<string | number, unknown>)[key] = child;
    }
    if (child === null || typeof child !== "object" || !(Array.isArray(child) || Object.getPrototypeOf(child) === null)) {
      throw new KAPError("Field path conflicts with scalar: " + path);
    }
    parent = child as Record<string, unknown> | unknown[];
  }
  const last = parts[parts.length - 1]!;
  const key = Array.isArray(parent) ? Number(last) : last;
  if (Array.isArray(parent) && (!Number.isInteger(key) || key < 0 || key > 1024)) throw new KAPError("Invalid array index");
  if (Object.hasOwn(parent, key)) throw new KAPError("Field already assigned: " + path);
  (parent as Record<string | number, unknown>)[key] = value;
  assigned.add(path);
}

function complete(value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length > 1025) throw new KAPError("Array too large");
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new KAPError("Sparse arrays are not allowed");
      complete(value[i]);
    }
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) complete(entry);
  }
}

/** Never guess a response from prose or interpret a competing second envelope. */
export function parseKAP(raw: string): KAPMessage {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > MAX_BYTES) throw new KAPError("KAP payload exceeds 64 KiB");
  let input = raw.trim();
  const fence = /^```(?:kap|text)?\r?\n([\s\S]*?)\r?\n```$/i.exec(input);
  if (fence) input = fence[1]!;
  const lines = input.split("\n");
  if (lines.length > MAX_LINES || lines[0]?.replace(/\r$/, "") !== "KITT/1") throw new KAPError("Missing KITT/1 header");
  if (lines[lines.length - 1]?.replace(/\r$/, "") !== "KITT/END") throw new KAPError("Missing KITT/END terminator");
  let action: KAPAction | undefined;
  let tool: string | null = null;
  let summary = "";
  const root: Record<string, unknown> = Object.create(null);
  const assigned = new Set<string>();
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line.startsWith("ACTION ") && action === undefined) {
      const next = line.slice(7);
      if (!["TOOL", "FINAL", "WORKSPACE", "TOOLS"].includes(next)) throw new KAPError("Unknown action");
      action = next as KAPAction;
    } else if (line.startsWith("TOOL ") && tool === null && TOOL.test(line.slice(5))) {
      tool = line.slice(5);
    } else if (line.startsWith("SUMMARY ") && !summary) {
      summary = line.slice(8);
      if (summary.length > 400) throw new KAPError("SUMMARY too long");
    } else if (line.startsWith("TEXT ")) {
      const path = line.slice(5);
      const until = lines.findIndex((next, index) => index > i && next.replace(/\r$/, "") === "KITT/ENDTEXT");
      if (until < 0 || until >= lines.length - 1) throw new KAPError("Unterminated TEXT field");
      assign(root, path, lines.slice(i + 1, until).join("\n"), assigned);
      i = until;
    } else {
      const match = /^(STRING|INTEGER|BOOLEAN|NULL|ARRAY|OBJECT) ([A-Za-z0-9_.]+)(?: = (.*))?$/.exec(line);
      if (!match) throw new KAPError("Unexpected KAP line: " + line.slice(0, 80));
      const [, type, path, rawValue] = match;
      let value: unknown;
      if (type === "STRING") {
        if (rawValue === undefined) throw new KAPError("STRING requires a value");
        value = rawValue;
      } else if (type === "INTEGER") {
        if (!rawValue || !/^-?(0|[1-9][0-9]*)$/.test(rawValue) || !Number.isSafeInteger(Number(rawValue))) throw new KAPError("Invalid INTEGER");
        value = Number(rawValue);
      } else if (type === "BOOLEAN") {
        if (rawValue !== "true" && rawValue !== "false") throw new KAPError("Invalid BOOLEAN");
        value = rawValue === "true";
      } else {
        if (rawValue !== undefined) throw new KAPError("Unexpected value for " + type);
        value = type === "ARRAY" ? [] : type === "OBJECT" ? Object.create(null) : null;
      }
      assign(root, path!, value, assigned);
    }
  }
  if (!action) throw new KAPError("Missing ACTION");
  complete(root);
  if (action === "TOOL") {
    if (!tool || !Object.keys(root).length) throw new KAPError("TOOL needs tool name and arguments");
    return { action: "use_tool", tool, tool_input: root, content: null, reasoning_summary: summary, loop: null };
  }
  if (tool) throw new KAPError("Non-tool action must not declare TOOL");
  if (Object.keys(root).some((name) => name !== "content")) throw new KAPError("Non-tool fields must start at content");
  const content = root.content;
  if (action === "FINAL" && (content === undefined || content === null || typeof content === "string" && !content.trim())) {
    throw new KAPError("FINAL requires content");
  }
  if (content !== undefined && content !== null && typeof content !== "string"
    && (Array.isArray(content) || typeof content !== "object")) throw new KAPError("Invalid content type");
  return {
    action: action === "FINAL" ? "final_response" : action === "WORKSPACE" ? "request_workspace" : "request_tools",
    tool: null, tool_input: null,
    content: (content ?? null) as string | Record<string, unknown> | null,
    reasoning_summary: summary, loop: null
  };
}
