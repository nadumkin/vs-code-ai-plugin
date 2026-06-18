"use strict";
// Orchestrates the full 2^3 ablation on a fixed JavaBench subsample.
// Generation (our agent replaces inference.py) + scoring (JavaBench evaluation.py).
//
// Env:
//   OPENROUTER_API_KEY  (required)
//   BENCH_MODEL         (default openai/gpt-4o-mini)
//   BENCH_BASE_URL      (default OpenRouter chat/completions)
//   BENCH_JAVA_HOME     (default /opt/homebrew/opt/openjdk@17)
//   BENCH_ONLY          (optional comma list of config names to run)

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BENCH = __dirname;
const JB = path.join(BENCH, "JavaBench");
const RUNS = path.join(BENCH, "runs");
const OUTPUT = path.join(BENCH, "output");
const VENV_PY = path.join(BENCH, ".venv", "bin", "python");
const PYSTUBS = path.join(BENCH, "pystubs");

const JAVA_HOME = process.env.BENCH_JAVA_HOME || "/opt/homebrew/opt/openjdk@17";
process.env.JAVA_HOME = JAVA_HOME;
process.env.PATH = `${path.join(JAVA_HOME, "bin")}:${process.env.PATH}`;

const MODEL = process.env.BENCH_MODEL || "openai/gpt-4o-mini";
const BASE_URL = process.env.BENCH_BASE_URL || "https://openrouter.ai/api/v1/chat/completions";
const API_KEY = process.env.OPENROUTER_API_KEY || "";

const { CONFIGS } = require("./configs");
const adapter = require("./javabench-adapter");
const { runTask } = require("./agent-driver");

function loadSubsetTasks() {
  const subset = JSON.parse(fs.readFileSync(path.join(BENCH, "subset.json"), "utf8"));
  const wanted = new Set(subset.task_ids);
  const all = adapter.loadAllTasks();
  const byId = new Map(all.map((t) => [t.task_id, t]));
  // preserve subset.json order
  return subset.task_ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

function isPass(rec) {
  if (!rec) return false;
  const tr = rec.test_result || [0, 0];
  return rec.compile_errors === 0 && tr[1] > 0 && tr[0] === tr[1];
}

function scoreConfig(samplesPath, outJson) {
  execFileSync(
    VENV_PY,
    ["evaluation.py", "class-wise", samplesPath, "--output", outJson],
    {
      cwd: JB,
      env: { ...process.env, PYTHONPATH: PYSTUBS },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 60 * 60 * 1000,
    }
  );
  return JSON.parse(fs.readFileSync(outJson, "utf8"));
}

async function main() {
  if (!API_KEY) {
    console.error("ERROR: set OPENROUTER_API_KEY in the environment.");
    process.exit(1);
  }
  const onlyFilter = (process.env.BENCH_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
  const configs = onlyFilter.length ? CONFIGS.filter((c) => onlyFilter.includes(c.name)) : CONFIGS;

  const tasks = loadSubsetTasks();
  console.log(`Model=${MODEL}  configs=${configs.length}  tasks=${tasks.length}`);
  fs.mkdirSync(RUNS, { recursive: true });
  fs.mkdirSync(OUTPUT, { recursive: true });

  const results = { model: MODEL, baseUrl: BASE_URL, createdAt: new Date().toISOString(), configs: {} };

  for (const config of configs) {
    const runDir = path.join(RUNS, config.name);
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });

    const samples = [];
    const metas = [];
    let idx = 0;
    for (const task of tasks) {
      idx += 1;
      process.stdout.write(`[${config.name}] (${idx}/${tasks.length}) ${task.task_id} ... `);
      const started = Date.now();
      try {
        const { sample, meta } = await runTask({
          task, axes: config.axes, runDir, model: MODEL, baseUrl: BASE_URL, apiKey: API_KEY,
          logger: (m) => console.log("\n  " + m),
        });
        samples.push(sample);
        metas.push({ task_id: task.task_id, ...meta, ms: Date.now() - started });
        console.log(`${meta.status} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      } catch (e) {
        samples.push({ task_id: task.task_id, target: task.target, prompt: "", completion: "```java\n```" });
        metas.push({ task_id: task.task_id, status: "driver-error", errorMessage: e.message, ms: Date.now() - started });
        console.log(`driver-error: ${e.message}`);
      }
      // free per-task workspace to keep disk in check
      const safeId = task.task_id.replace(/[^\w.-]+/g, "_");
      fs.rmSync(path.join(runDir, "work", safeId), { recursive: true, force: true });
    }

    const outDir = path.join(OUTPUT, config.name);
    fs.mkdirSync(outDir, { recursive: true });
    const samplesPath = path.join(outDir, "samples.jsonl");
    fs.writeFileSync(samplesPath, samples.map((s) => JSON.stringify(s)).join("\n") + "\n");

    console.log(`[${config.name}] scoring ${samples.length} samples via evaluation.py ...`);
    const scoreOut = path.join(outDir, "score.json");
    let scored = [];
    try {
      scored = scoreConfig(samplesPath, scoreOut);
    } catch (e) {
      console.error(`[${config.name}] scoring failed: ${e.message}`);
    }
    const passed = scored.filter(isPass).length;
    const total = scored.length || tasks.length;
    results.configs[config.name] = {
      axes: config.axes,
      passed,
      total,
      passAt1: total ? passed / total : 0,
      perTask: scored.map((r) => ({ task_id: r.task_id, pass: isPass(r), compile_errors: r.compile_errors, test_result: r.test_result })),
      meta: metas,
    };
    console.log(`[${config.name}] pass@1 = ${passed}/${total} = ${(100 * passed / (total || 1)).toFixed(1)}%`);
  }

  const resultsPath = path.join(BENCH, "results.json");
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nWrote ${resultsPath}`);
  console.log("Run `node report.js` for the comparison table.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
