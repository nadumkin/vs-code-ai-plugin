"use strict";
// Renders results.json into a comparison table + per-axis contribution analysis.
// Output: console (Markdown) + bench/report.md + bench/report.csv

const fs = require("fs");
const path = require("path");

const BENCH = __dirname;
const results = JSON.parse(fs.readFileSync(path.join(BENCH, "results.json"), "utf8"));
const order = ["it0_mem0_rag0", "it0_mem0_rag1", "it0_mem1_rag0", "it0_mem1_rag1",
  "it1_mem0_rag0", "it1_mem0_rag1", "it1_mem1_rag0", "it1_mem1_rag1"];

const names = order.filter((n) => results.configs[n]);
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const yn = (b) => (b ? "✓" : "·");

// ---- main table -------------------------------------------------------------
const rows = names.map((n) => {
  const c = results.configs[n];
  return {
    name: n,
    it: c.axes.iterative, mem: c.axes.memory, rag: c.axes.rag,
    passed: c.passed, total: c.total, p1: c.passAt1,
  };
});

let md = [];
md.push(`# JavaBench ablation — pass@1`);
md.push("");
md.push(`- Model: \`${results.model}\``);
md.push(`- Tasks (subsample): ${rows[0] ? rows[0].total : "?"}`);
md.push(`- Generated: ${results.createdAt}`);
md.push("");
md.push(`| Config | Iter.debug | Memory | RAG | pass@1 | passed/total |`);
md.push(`|---|:--:|:--:|:--:|--:|--:|`);
for (const r of rows) {
  md.push(`| \`${r.name}\` | ${yn(r.it)} | ${yn(r.mem)} | ${yn(r.rag)} | ${pct(r.p1)} | ${r.passed}/${r.total} |`);
}
md.push("");

// ---- per-axis average contribution (full factorial) -------------------------
function avgDelta(axis) {
  // average over the 4 pairs where `axis` flips and the other two axes are fixed
  let sum = 0, n = 0;
  for (const r of rows) {
    if (r[axis]) continue; // r is the OFF side
    const onName = r.name.replace(
      axis === "it" ? /^it0/ : axis === "mem" ? /mem0/ : /rag0/,
      axis === "it" ? "it1" : axis === "mem" ? "mem1" : "rag1"
    );
    const on = results.configs[onName];
    if (!on) continue;
    sum += on.passAt1 - r.p1;
    n += 1;
  }
  return n ? sum / n : 0;
}

const axisName = { it: "Итеративная отладка", mem: "QKV-память", rag: "RAG" };
md.push(`## Средний вклад каждой опции (Δ pass@1)`);
md.push("");
md.push(`| Опция | Средняя Δ pass@1 |`);
md.push(`|---|--:|`);
for (const axis of ["it", "mem", "rag"]) {
  const d = avgDelta(axis);
  md.push(`| ${axisName[axis]} | ${d >= 0 ? "+" : ""}${(100 * d).toFixed(1)} п.п. |`);
}
md.push("");
md.push(`> Δ — усреднённое изменение pass@1 при включении опции по 4 парам конфигов,`);
md.push(`> где две другие опции зафиксированы (полный факторный план 2³).`);
md.push("");
md.push(`### Оговорки`);
md.push(`- QKV-память накапливается по задачам внутри прогона; эффект зависит от порядка задач (фиксирован в \`subset.json\`).`);
md.push(`- Память наполняется значением через compile-probe харнесса, поэтому её ось не зависит от итеративной отладки.`);
md.push(`- Итеративная отладка по умолчанию использует только компиляцию (\`gradlew compileJava\`), без грейдинг-тестов — без утечки.`);

const mdText = md.join("\n") + "\n";
fs.writeFileSync(path.join(BENCH, "report.md"), mdText);

// ---- CSV --------------------------------------------------------------------
const csv = ["config,iterative,memory,rag,passed,total,pass_at_1"];
for (const r of rows) {
  csv.push(`${r.name},${r.it ? 1 : 0},${r.mem ? 1 : 0},${r.rag ? 1 : 0},${r.passed},${r.total},${r.p1.toFixed(4)}`);
}
fs.writeFileSync(path.join(BENCH, "report.csv"), csv.join("\n") + "\n");

console.log(mdText);
console.log(`Wrote ${path.join(BENCH, "report.md")} and report.csv`);
