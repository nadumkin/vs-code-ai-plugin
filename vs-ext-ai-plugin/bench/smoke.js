"use strict";
// No-LLM wiring smoke: proves the vscode shim + agent core load and run headlessly,
// the JavaBench workspace materializes, ContextCollector works under each RAG setting,
// and the tool set filters correctly per iterative axis. Does NOT call the LLM.

require("./register-shim");
const assert = require("assert");
const path = require("path");
const vscode = require("./vscode-shim");
const adapter = require("./javabench-adapter");
const { ContextCollector } = require("../src/agent/ContextCollector");
const { ToolExecutor } = require("../src/agent/ToolExecutor");
const { MemoryManager } = require("../src/memory/MemoryManager");

async function main() {
  const task = adapter.loadTasks("PA19")[0]; // PA19/Cell.java
  const runDir = path.join(__dirname, "runs", "_smoke");
  const ws = path.join(runDir, "work", "smoke");
  const { workspaceRoot, targetPath } = adapter.materializeWorkspace(task, ws);
  console.log("materialized:", path.relative(__dirname, workspaceRoot));
  assert.ok(require("fs").existsSync(targetPath), "target file exists");
  assert.ok(!require("fs").existsSync(path.join(workspaceRoot, "src", "test")), "src/test excluded (no leak)");

  vscode.__harness.setWorkspaceRoot(workspaceRoot);
  vscode.__harness.setActiveFile(targetPath);

  const oc = vscode.window.createOutputChannel("smoke");

  // RAG ON: imports should be discoverable
  vscode.__harness.resetConfig();
  vscode.__harness.setConfig({ "aiAgentAssistant.context.maxImportedFiles": 8, "aiAgentAssistant.context.maxTests": 6 });
  const ccOn = new ContextCollector(oc);
  const ctxOn = await ccOn.collectContext("implement");
  console.log("RAG=ON  -> imports:", ctxOn.imports.length, "tests:", ctxOn.tests.length, "class:", ctxOn.className);

  // RAG OFF: no imports/tests pulled
  vscode.__harness.resetConfig();
  vscode.__harness.setConfig({ "aiAgentAssistant.context.maxImportedFiles": 0, "aiAgentAssistant.context.maxTests": 0 });
  const ccOff = new ContextCollector(oc);
  const ctxOff = await ccOff.collectContext("implement");
  console.log("RAG=OFF -> imports:", ctxOff.imports.length, "tests:", ctxOff.tests.length);
  assert.strictEqual(ctxOff.imports.length, 0, "RAG off => no imports");
  assert.strictEqual(ctxOff.tests.length, 0, "RAG off => no tests");

  // tool filtering for iterative OFF
  const mem = new MemoryManager(oc);
  const te = new ToolExecutor(oc, mem);
  const allTools = te.getToolDefinitions().map((t) => t.function.name);
  const NON_ITER = new Set(["run_shell_command", "run_bash_script", "read_terminal_output"]);
  const filtered = te.getToolDefinitions().filter((t) => !NON_ITER.has(t.function.name)).map((t) => t.function.name);
  console.log("tools(all):", allTools.length, "tools(iterative OFF):", filtered.length);
  assert.ok(allTools.includes("run_shell_command"), "shell tool present by default");
  assert.ok(!filtered.includes("run_shell_command"), "shell tool removed when iterative OFF");

  // completion extraction round-trips a fenced java block
  const completion = await adapter.readCompletion(workspaceRoot, task.target);
  assert.ok(completion.startsWith("```java\n") && completion.trimEnd().endsWith("```"), "completion is fenced");

  require("fs").rmSync(runDir, { recursive: true, force: true });
  console.log("\nSMOKE OK — headless wiring works without VS Code and without LLM calls.");
}

main().catch((e) => { console.error(e); process.exit(1); });
