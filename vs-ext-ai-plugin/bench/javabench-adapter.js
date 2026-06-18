"use strict";
// Adapts JavaBench (minimum-context) tasks to the agent harness:
//  - loads tasks from datasets/minimum-context/data-PA*.jsonl
//  - materializes a per-task workspace = PA{n}-Solution with the single target
//    class reverted to its skeleton, and src/test EXCLUDED (so neither RAG nor
//    the iterative loop can leak the grading tests — scoring uses JavaBench's
//    own TestEnv with its own tests)
//  - extracts the agent's final target file as a fenced `completion`

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const JB_ROOT = path.join(__dirname, "JavaBench");
const PROJECTS = ["PA19", "PA20", "PA21", "PA22"];

// directories from the Solution copy that must NOT reach the agent workspace
const EXCLUDE_DIRS = new Set(["test", "out", "build", ".gradle", "img"]);

function datasetPath(projectId) {
  return path.join(JB_ROOT, "datasets", "minimum-context", `data-${projectId}.jsonl`);
}

function loadTasks(projectId) {
  const raw = fs.readFileSync(datasetPath(projectId), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .map((r) => ({ ...r, projectId }));
}

function loadAllTasks(projectIds = PROJECTS) {
  return projectIds.flatMap((p) => loadTasks(p));
}

// strip the ```java ... ``` fence from a dataset `code` field, returning raw source
function stripFence(code) {
  const m = String(code || "").match(/```(?:java)?\r?\n([\s\S]*?)```/);
  return m ? m[1] : String(code || "");
}

function targetAbsPath(workspaceRoot, target) {
  return path.join(workspaceRoot, "src", "main", "java", target);
}

// Recursively copy the Solution tree, skipping test/build/img dirs.
function copyFiltered(srcDir, destDir, relRoot = "") {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    const rel = path.join(relRoot, entry.name);
    if (entry.isDirectory()) {
      // exclude the test source root specifically (src/test) and heavy build dirs
      if (rel === path.join("src", "test")) continue;
      if (relRoot === "" && EXCLUDE_DIRS.has(entry.name)) continue;
      copyFiltered(srcPath, destPath, rel);
    } else if (entry.isSymbolicLink()) {
      // skip symlinks
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Build the per-task workspace; returns { workspaceRoot, targetPath }.
function materializeWorkspace(task, destRoot) {
  const solution = path.join(JB_ROOT, "projects", `${task.projectId}-Solution`);
  if (!fs.existsSync(solution)) {
    throw new Error(`Solution project not found: ${solution}`);
  }
  fs.rmSync(destRoot, { recursive: true, force: true });
  copyFiltered(solution, destRoot);

  // revert the single target class to its skeleton (the dataset `code`)
  const skeleton = stripFence(task.code);
  const tgt = targetAbsPath(destRoot, task.target);
  fs.mkdirSync(path.dirname(tgt), { recursive: true });
  fs.writeFileSync(tgt, skeleton, "utf8");

  return { workspaceRoot: destRoot, targetPath: tgt };
}

// Read the agent's final target file and wrap as a fenced completion for evaluation.py.
async function readCompletion(workspaceRoot, target) {
  const tgt = targetAbsPath(workspaceRoot, target);
  let content = "";
  try {
    content = await fsp.readFile(tgt, "utf8");
  } catch (_e) {
    content = "";
  }
  return "```java\n" + content + "\n```";
}

module.exports = {
  JB_ROOT,
  PROJECTS,
  loadTasks,
  loadAllTasks,
  stripFence,
  targetAbsPath,
  materializeWorkspace,
  readCompletion,
};
