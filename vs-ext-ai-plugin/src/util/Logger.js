"use strict";
// Structured JSONL session logger for the AI Agent Assistant.
// One file per VS Code window lifetime:
//   <workspace>/.aiAgentAssistant/logs/session-<ISO>.jsonl
// Fallback path (no workspace): <extension global storage>/logs/session-<ISO>.jsonl.
//
// Every entry is one line: { ts, seq, type, payload }
// `payload` is sanitized for secrets (Authorization, api*, key, token, secret).
//
// All writes go through an async serial queue so callers never await disk I/O.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const vscode = require("vscode");

const SECRET_KEY_RE = /(authorization|api[_-]?key|secret|token)/i;
const REDACT = "[REDACTED]";
const DEFAULT_REL_DIR = path.join(".aiAgentAssistant", "logs");

class Logger {
  /**
   * @param {object} opts
   * @param {object} [opts.context] - vscode.ExtensionContext for globalStorage fallback
   * @param {object} [opts.outputChannel]
   */
  constructor({ context = null, outputChannel = null } = {}) {
    this.context = context;
    this.outputChannel = outputChannel;
    this.filePath = null;
    this.seq = 0;
    this.queue = Promise.resolve();
    this.disabled = false;
    this._initError = null;
  }

  isEnabled() {
    if (this.disabled) return false;
    try {
      return Boolean(
        vscode.workspace
          .getConfiguration("aiAgentAssistant")
          .get("logging.enabled", true)
      );
    } catch (_e) {
      return false;
    }
  }

  resolveLogPath() {
    try {
      const configured = String(
        vscode.workspace
          .getConfiguration("aiAgentAssistant")
          .get("logging.directory", "") || ""
      ).trim();
      let dir = null;
      if (configured) {
        dir = path.isAbsolute(configured)
          ? configured
          : path.join(
              vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd(),
              configured
            );
      } else if (vscode.workspace.workspaceFolders?.[0]) {
        dir = path.join(
          vscode.workspace.workspaceFolders[0].uri.fsPath,
          DEFAULT_REL_DIR
        );
      } else if (this.context?.globalStorageUri?.fsPath) {
        dir = path.join(this.context.globalStorageUri.fsPath, "logs");
      } else {
        dir = path.join(require("os").tmpdir(), "aiAgentAssistant-logs");
      }
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .replace("Z", "");
      return path.join(dir, `session-${stamp}.jsonl`);
    } catch (e) {
      this._initError = e;
      return null;
    }
  }

  ensurePath() {
    if (this.filePath) return this.filePath;
    this.filePath = this.resolveLogPath();
    if (this.filePath) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      } catch (e) {
        this._initError = e;
      }
    }
    return this.filePath;
  }

  append(type, payload) {
    if (!this.isEnabled()) return;
    const filePath = this.ensurePath();
    if (!filePath) return;

    const entry = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      type: String(type || "unknown"),
      payload: redact(payload),
    };
    const line = safeStringify(entry) + "\n";

    // serialize writes so order matches event order
    this.queue = this.queue.then(() =>
      fsp.appendFile(filePath, line, "utf8").catch((e) => {
        this.outputChannel?.appendLine(
          `[Logger] append failed (${filePath}): ${e?.message || e}`
        );
      })
    );
  }

  async flush() {
    try {
      await this.queue;
    } catch (_e) {
      // never throw on flush
    }
  }

  getCurrentLogPath() {
    return this.filePath;
  }
}

function redact(value, depth = 0) {
  if (depth > 8) return REDACT;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > 16384) {
      return value.slice(0, 16384) + `…[+${value.length - 16384} chars]`;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = REDACT;
        continue;
      }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch (_e) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      seq: 0,
      type: "log_serialize_error",
      payload: { message: "unable to stringify entry" },
    });
  }
}

// no-op stub used when logging is fully disabled or no logger available
class NullLogger {
  isEnabled() { return false; }
  append() {}
  flush() { return Promise.resolve(); }
  getCurrentLogPath() { return null; }
}

module.exports = {
  Logger,
  NullLogger,
  redact,
};
