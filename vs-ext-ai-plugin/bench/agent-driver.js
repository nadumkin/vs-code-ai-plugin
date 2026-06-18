"use strict";
// Runs ONE JavaBench task under ONE ablation config, fully headless.
// Requires register-shim to have been loaded by the entrypoint BEFORE this file
// pulls in any src/* module.

require("./register-shim");
const path = require("path");
const { execFile } = require("child_process");

const vscode = require("./vscode-shim");
const { ContextCollector } = require("../src/agent/ContextCollector");
const { OpenRouterClient } = require("../src/agent/OpenRouterClient");
const { ToolExecutor } = require("../src/agent/ToolExecutor");
const { AgentRuntime } = require("../src/agent/AgentRuntime");
const { MemoryManager } = require("../src/memory/MemoryManager");
const adapter = require("./javabench-adapter");

const NON_ITERATIVE_TOOLS = new Set([
  "run_shell_command",
  "run_bash_script",
  "read_terminal_output",
]);
const MAX_CONTINUATIONS = 4;

function secretShim(apiKey) {
  return {
    async get() { return apiKey; },
    async store() {},
    async delete() {},
  };
}

function buildPrompt(task, axes) {
  const lines = [
    `Implement the Java class in the active file: ${task.target}.`,
    `Replace every \`// TODO\` with a correct implementation so the class is complete and compiles.`,
    `Keep the package declaration, import statements, and all class/field/method signatures EXACTLY as given.`,
    `Do NOT add, remove, or change import statements — the grader keeps the skeleton's imports and discards yours, so any symbol needing a new import will fail.`,
    `Write the COMPLETE final class back to the active file using the replace_active_file tool (one call, full file).`,
  ];
  if (axes.iterative) {
    lines.push(`You may run \`./gradlew compileJava -q --console=plain\` to check for compilation errors and fix them. Do NOT run the test suite.`);
  } else {
    lines.push(`Do not run any shell commands; produce the implementation directly.`);
  }
  return lines.join("\n");
}

function configFor(axes, { runDir, model, baseUrl }) {
  // keys are read via getConfiguration("aiAgentAssistant").get("<key>"),
  // so the shim stores them under the "aiAgentAssistant." prefix.
  const P = "aiAgentAssistant.";
  const raw = {
    "execution.autoApplyFileChanges": true,
    "execution.requireConfirmation": false,
    "execution.commandTimeoutMs": 180000,
    "openRouter.model": model,
    "openRouter.baseUrl": baseUrl,
    "openRouter.requestTimeoutMs": 180000,
    "agent.maxIterations": axes.iterative ? 8 : 3,
    "memory.enabled": !!axes.memory,
    "memory.storagePath": path.join(runDir, "memory-store.json"),
    "memory.java.enabled": true,
    "memory.java.bytecodeProbe": "off", // classes aren't compiled in the agent workspace by default
    "memory.rerank.enabled": true,
    "context.maxImportedFiles": axes.rag ? 8 : 0,
    "context.maxTests": axes.rag ? 6 : 0,
    "context.maxFileChars": 16000,
    // benchmark workspaces are ephemeral — don't write JSONL session logs there
    "logging.enabled": false,
  };
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[P + k] = v;
  return out;
}

function gradleCompile(workspaceRoot, timeoutMs = 180000) {
  return new Promise((resolve) => {
    execFile(
      "./gradlew",
      ["compileJava", "-q", "--console=plain", "--rerun-tasks"],
      { cwd: workspaceRoot, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout || "", stderr: stderr || "" });
      }
    );
  });
}

async function runTask({ task, axes, runDir, model, baseUrl, apiKey, logger }) {
  const log = logger || (() => {});
  const safeId = task.task_id.replace(/[^\w.-]+/g, "_");
  const workspaceRoot = path.join(runDir, "work", safeId);
  const { targetPath } = adapter.materializeWorkspace(task, workspaceRoot);

  // configure the shim (this is the ablation toggle point)
  vscode.__harness.resetConfig();
  vscode.__harness.setConfig(configFor(axes, { runDir, model, baseUrl }));
  vscode.__harness.setWorkspaceRoot(workspaceRoot);
  vscode.__harness.setActiveFile(targetPath);

  const outputChannel = vscode.window.createOutputChannel("bench");
  const openRouterClient = new OpenRouterClient(secretShim(apiKey), outputChannel);
  const memoryManager = new MemoryManager(outputChannel);
  const toolExecutor = new ToolExecutor(outputChannel, memoryManager);
  const contextCollector = new ContextCollector(outputChannel);

  if (!axes.iterative) {
    const orig = toolExecutor.getToolDefinitions.bind(toolExecutor);
    toolExecutor.getToolDefinitions = () =>
      orig().filter((t) => !NON_ITERATIVE_TOOLS.has(t.function && t.function.name));
  }

  const runtime = new AgentRuntime({ contextCollector, openRouterClient, toolExecutor, outputChannel });

  const prompt = buildPrompt(task, axes);
  const iterationLimit = axes.iterative ? 8 : 3;
  let llmCalls = 0;
  const onToolEvent = () => {};
  const onStatus = () => { llmCalls += 1; };

  let status = "unknown";
  let errorMessage = null;
  try {
    let result = await runtime.runTurn({ prompt, history: [], iterationLimit, onStatus, onToolEvent });
    let guard = 0;
    while (result && result.status === "needsContinuation" && guard < MAX_CONTINUATIONS) {
      guard += 1;
      result = await runtime.runTurn({
        iterationLimit,
        continuationState: result.continuationState,
        onStatus,
        onToolEvent,
      });
    }
    status = result ? result.status : "unknown";
  } catch (e) {
    status = "error";
    errorMessage = e && e.message ? e.message : String(e);
    log(`[task ${task.task_id}] agent error: ${errorMessage}`);
  }

  // memory value population (independent of iterative axis): one compile probe
  if (axes.memory) {
    try {
      const probe = await gradleCompile(workspaceRoot);
      await memoryManager.maybeRecordTestOutput({
        commandText: "./gradlew compileJava",
        stdout: probe.stdout,
        stderr: probe.stderr,
      });
    } catch (e) {
      log(`[task ${task.task_id}] memory probe failed: ${e && e.message}`);
    }
  }

  const completion = await adapter.readCompletion(workspaceRoot, task.target);

  return {
    sample: { task_id: task.task_id, target: task.target, prompt, completion },
    meta: { status, errorMessage, llmCalls, workspaceRoot },
  };
}

module.exports = { runTask, configFor, buildPrompt };
