// stdout is the MCP transport, so every log line must go to stderr.
const write = (level: string, msg: string, extra?: unknown) => {
  const line = `[faststats-mcp] ${level} ${msg}${extra === undefined ? "" : " " + safe(extra)}`;
  process.stderr.write(line + "\n");
};

const safe = (v: unknown) => {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
};

export const log = {
  info: (msg: string, extra?: unknown) => write("INFO", msg, extra),
  warn: (msg: string, extra?: unknown) => write("WARN", msg, extra),
  error: (msg: string, extra?: unknown) => write("ERROR", msg, extra),
};
