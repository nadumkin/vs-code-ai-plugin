"use strict";
// Minimal headless implementation of the slice of the `vscode` API that the
// agent core (src/agent/*, src/memory/*) actually touches. Backed by real
// node fs + fast-glob, an in-memory config map (the toggle point for ablation
// axes), and a settable "active editor". NO VS Code, NO UI.
//
// The inventory of required APIs was derived from a full scan of the source;
// see /docs and the ablation plan. Anything UI/diff-related is a no-op because
// the harness forces execution.autoApplyFileChanges=true (writes apply directly,
// the diff path is never taken) and execution.requireConfirmation=false.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const fg = require("fast-glob");

// ---- in-memory configuration (flat: "aiAgentAssistant.<key>") --------------
const configStore = new Map();

function setConfig(overrides) {
  for (const [key, value] of Object.entries(overrides || {})) {
    configStore.set(key, value);
  }
}

function resetConfig() {
  configStore.clear();
}

// ---- workspace / active editor state ---------------------------------------
let workspaceRoot = process.cwd();
let activeEditor = null;

function setWorkspaceRoot(root) {
  workspaceRoot = path.resolve(root);
}

function clearActiveEditor() {
  activeEditor = null;
}

function setActiveFile(fsPath) {
  const abs = path.resolve(fsPath);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const uri = Uri.file(abs);
  const document = {
    uri,
    fileName: abs,
    languageId: guessLanguageId(abs),
    lineCount: text.split(/\r?\n/).length,
    getText(range) {
      if (!range) return text;
      return "";
    },
  };
  activeEditor = {
    document,
    selection: {
      isEmpty: true,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
  };
  return activeEditor;
}

function guessLanguageId(fsPath) {
  const ext = path.extname(fsPath).toLowerCase();
  const map = {
    ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala",
    ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript",
    ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python", ".cs": "csharp", ".go": "go", ".rb": "ruby",
    ".php": "php", ".cpp": "cpp", ".c": "c", ".rs": "rust",
  };
  return map[ext] || "plaintext";
}

// ---- Uri --------------------------------------------------------------------
class Uri {
  constructor(fsPath) {
    this.scheme = "file";
    this.fsPath = fsPath;
    this.path = fsPath;
  }
  static file(p) {
    return new Uri(path.resolve(p));
  }
  static joinPath(base, ...segments) {
    return new Uri(path.join(base.fsPath, ...segments));
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

// ---- workspace.fs -----------------------------------------------------------
const workspaceFs = {
  async readFile(uri) {
    const buf = await fsp.readFile(uri.fsPath);
    return new Uint8Array(buf);
  },
  async writeFile(uri, content) {
    await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fsp.writeFile(uri.fsPath, Buffer.from(content));
  },
  async stat(uri) {
    const st = await fsp.stat(uri.fsPath);
    return {
      type: st.isDirectory() ? FileType.Directory : st.isFile() ? FileType.File : FileType.Unknown,
      size: st.size,
      ctime: st.ctimeMs,
      mtime: st.mtimeMs,
    };
  },
  async createDirectory(uri) {
    await fsp.mkdir(uri.fsPath, { recursive: true });
  },
};

// ---- glob (findFiles) -------------------------------------------------------
function toFgPattern(glob) {
  return String(glob || "**/*");
}

async function findFiles(include, exclude, maxResults) {
  const patterns = [toFgPattern(include)];
  const ignore = [];
  if (exclude) ignore.push(String(exclude));
  let entries = [];
  try {
    entries = await fg(patterns, {
      cwd: workspaceRoot,
      ignore,
      absolute: true,
      onlyFiles: true,
      dot: false,
      suppressErrors: true,
      followSymbolicLinks: false,
    });
  } catch (_e) {
    entries = [];
  }
  if (typeof maxResults === "number" && maxResults > 0) {
    entries = entries.slice(0, maxResults);
  }
  return entries.map((p) => Uri.file(p));
}

function asRelativePath(uriOrString, _includeWorkspaceFolder) {
  const fsPath = typeof uriOrString === "string" ? uriOrString : uriOrString.fsPath;
  const rel = path.relative(workspaceRoot, fsPath);
  return rel || fsPath;
}

function getWorkspaceFolder(uri) {
  const fsPath = typeof uri === "string" ? uri : uri.fsPath;
  if (fsPath && fsPath.startsWith(workspaceRoot)) {
    return workspaceFolder();
  }
  return undefined;
}

function workspaceFolder() {
  return { uri: Uri.file(workspaceRoot), name: path.basename(workspaceRoot), index: 0 };
}

// ---- configuration ----------------------------------------------------------
function getConfiguration(section) {
  const prefix = section ? `${section}.` : "";
  return {
    get(key, defaultValue) {
      const full = `${prefix}${key}`;
      if (configStore.has(full)) return configStore.get(full);
      return defaultValue;
    },
    update(key, value) {
      configStore.set(`${prefix}${key}`, value);
      return Promise.resolve();
    },
    has(key) {
      return configStore.has(`${prefix}${key}`);
    },
  };
}

// ---- window -----------------------------------------------------------------
function createOutputChannel(_name) {
  const lines = [];
  return {
    appendLine(s) { lines.push(String(s)); },
    append(s) { lines.push(String(s)); },
    clear() { lines.length = 0; },
    show() {},
    hide() {},
    dispose() {},
    _lines: lines,
  };
}

const noopDisposable = { dispose() {} };

const vscode = {
  Uri,
  FileType,
  ConfigurationTarget,
  EventEmitter: class {
    constructor() { this.event = () => noopDisposable; }
    fire() {}
    dispose() {}
  },
  workspace: {
    get workspaceFolders() {
      return [workspaceFolder()];
    },
    getWorkspaceFolder,
    getConfiguration,
    findFiles,
    asRelativePath,
    fs: workspaceFs,
    openTextDocument: async (uri) => ({
      uri: typeof uri === "string" ? Uri.file(uri) : uri,
      getText: () => "",
    }),
    onDidChangeConfiguration: () => noopDisposable,
    onDidSaveTextDocument: () => noopDisposable,
    onDidChangeTextDocument: () => noopDisposable,
  },
  window: {
    get activeTextEditor() {
      return activeEditor;
    },
    showWarningMessage: async (_message, _options, ...items) => items[0],
    showInformationMessage: async (_message, ..._items) => undefined,
    showErrorMessage: async (_message, ..._items) => undefined,
    showTextDocument: async () => undefined,
    createOutputChannel,
    registerWebviewViewProvider: () => noopDisposable,
    onDidChangeActiveTextEditor: () => noopDisposable,
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => noopDisposable,
  },
};

// Control surface for the harness (not part of the real vscode API).
vscode.__harness = {
  setConfig,
  resetConfig,
  setWorkspaceRoot,
  setActiveFile,
  clearActiveEditor,
  getWorkspaceRoot: () => workspaceRoot,
};

module.exports = vscode;
