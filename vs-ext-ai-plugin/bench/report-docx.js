"use strict";
// Renders results.json into a detailed DOCX experiment report (RU).
// Requires the `docx` package (declared as a devDependency): run `npm install` first.
//
// Usage:
//   node report-docx.js [results.json] [output.docx]
// Defaults: ./results.json  ->  ../docs/Эксперимент JavaBench (ablation).docx

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat, HeadingLevel, BorderStyle,
  WidthType, ShadingType, PageNumber, PageBreak,
} = require("docx");

const RESULTS = process.argv[2] || path.join(__dirname, "results.json");
const OUT = process.argv[3] || path.join(__dirname, "..", "docs", "Эксперимент JavaBench (ablation).docx");
const r = JSON.parse(fs.readFileSync(RESULTS, "utf8"));

// ---------- compute metrics from results.json ----------
const names = Object.keys(r.configs);
const N = r.configs[names[0]].perTask.length;
const cfg = {};
for (const n of names) {
  const c = r.configs[n];
  let pass = 0, comp = 0, calls = 0, ms = 0, errs = 0;
  for (const t of c.perTask) { if (t.compile_errors === 0) comp++; if (t.pass) pass++; }
  for (const m of (c.meta || [])) { calls += m.llmCalls || 0; ms += m.ms || 0; if (m.status === "error" || m.status === "driver-error") errs++; }
  cfg[n] = { axes: c.axes, pass, comp, passRate: pass / N, compRate: comp / N, calls, sec: Math.round(ms / 1000), errs };
}
function avgDelta(metric, axis) {
  let s = 0, k = 0;
  for (const n of names) {
    const c = cfg[n]; if (c.axes[axis]) continue;
    const onName = n.replace(axis === "iterative" ? /^it0/ : axis === "memory" ? /mem0/ : /rag0/, axis === "iterative" ? "it1" : axis === "memory" ? "mem1" : "rag1");
    if (!cfg[onName]) continue; s += cfg[onName][metric] - c[metric]; k++;
  }
  return k ? s / k : 0;
}
const tasks = r.configs[names[0]].perTask.map((t) => t.task_id);
const buckets = { always: [], never: [], swing: [] };
for (const tid of tasks) {
  const p = names.map((n) => r.configs[n].perTask.find((x) => x.task_id === tid).pass).filter(Boolean).length;
  if (p === names.length) buckets.always.push(tid); else if (p === 0) buckets.never.push(tid); else buckets.swing.push(tid);
}
const totalCalls = names.reduce((a, n) => a + cfg[n].calls, 0);
const totalSec = names.reduce((a, n) => a + cfg[n].sec, 0);
const order = ["it0_mem0_rag0","it0_mem0_rag1","it0_mem1_rag0","it0_mem1_rag1","it1_mem0_rag0","it1_mem0_rag1","it1_mem1_rag0","it1_mem1_rag1"].filter((n)=>cfg[n]);

// ---------- styling helpers ----------
const FONT = "Arial", MONO = "Menlo";
const PAGE_W = 12240, PAGE_H = 15840, MARGIN = 1080, CW = PAGE_W - 2 * MARGIN;
const C = { text:"1F2937", muted:"6B7280", accent:"1D4ED8", head:"EFF3FB", border:"D1D5DB", good:"047857", bad:"B91C1C", warn:"B45309", codeBg:"F8FAFC" };
const H1 = (t)=>new Paragraph({heading:HeadingLevel.HEADING_1,spacing:{before:340,after:180},children:[new TextRun({text:t,bold:true,font:FONT,size:34,color:C.accent})]});
const H2 = (t)=>new Paragraph({heading:HeadingLevel.HEADING_2,spacing:{before:280,after:140},children:[new TextRun({text:t,bold:true,font:FONT,size:27,color:C.text})]});
const H3 = (t)=>new Paragraph({heading:HeadingLevel.HEADING_3,spacing:{before:220,after:110},children:[new TextRun({text:t,bold:true,font:FONT,size:23,color:C.text})]});
const P = (t,o={})=>new Paragraph({spacing:{after:120},children:[new TextRun({text:t,font:FONT,size:22,...o})]});
const Pr = (...runs)=>new Paragraph({spacing:{after:120},children:runs});
const run = (t,o={})=>new TextRun({text:t,font:FONT,size:22,...o});
const b = (t)=>new TextRun({text:t,font:FONT,size:22,bold:true});
const codeR = (t)=>new TextRun({text:t,font:MONO,size:20,color:C.accent});
const bullet = (t)=>new Paragraph({numbering:{reference:"b",level:0},spacing:{after:70},children:Array.isArray(t)?t:[new TextRun({text:t,font:FONT,size:22})]});
const num = (t)=>new Paragraph({numbering:{reference:"n",level:0},spacing:{after:70},children:Array.isArray(t)?t:[new TextRun({text:t,font:FONT,size:22})]});
const spacer=()=>new Paragraph({spacing:{after:80},children:[new TextRun({text:"",font:FONT})]});
const pb=()=>new Paragraph({children:[new PageBreak()]});
function codeBlock(lines){const arr=Array.isArray(lines)?lines:lines.split("\n");return arr.map((ln)=>new Paragraph({spacing:{after:0,line:250},shading:{type:ShadingType.CLEAR,fill:C.codeBg},indent:{left:160,right:160},children:[new TextRun({text:ln,font:MONO,size:17,color:C.text})]})).concat([spacer()]);}
const thin={style:BorderStyle.SINGLE,size:4,color:C.border};
function cell(text,o={}){const w=o.width||3000;const arr=Array.isArray(text)?text:[text];return new TableCell({width:{size:w,type:WidthType.DXA},margins:{top:60,bottom:60,left:110,right:110},shading:o.fill?{type:ShadingType.CLEAR,fill:o.fill}:(o.header?{type:ShadingType.CLEAR,fill:C.head}:undefined),children:arr.map((t)=>new Paragraph({alignment:o.align||AlignmentType.LEFT,children:[new TextRun({text:String(t),font:o.mono?MONO:FONT,size:o.header?20:19,bold:o.header||o.bold,color:o.color||C.text})]}))});}
function table(headers,rows,widths){const w=widths||headers.map(()=>Math.floor(CW/headers.length));return new Table({width:{size:w.reduce((a,x)=>a+x,0),type:WidthType.DXA},columnWidths:w,borders:{top:thin,bottom:thin,left:thin,right:thin,insideHorizontal:thin,insideVertical:thin},rows:[new TableRow({tableHeader:true,children:headers.map((h,i)=>cell(h,{header:true,width:w[i],align:i?AlignmentType.CENTER:AlignmentType.LEFT}))}),...rows.map((rw)=>new TableRow({children:rw.map((cv,i)=>typeof cv==="object"&&!Array.isArray(cv)?cellWith(cv,w[i]):cell(cv,{width:w[i],align:i?AlignmentType.CENTER:AlignmentType.LEFT,mono:rw.__mono}))}))]});}
function cellWith(spec,w){return cell(spec.t,{width:w,align:spec.align||AlignmentType.CENTER,color:spec.color,bold:spec.bold,fill:spec.fill});}
const pct=(x)=>`${(100*x).toFixed(0)}%`;
const yn=(v)=>v?"вкл":"—";
const ppc=(x)=>`${x>=0?"+":""}${(100*x).toFixed(1)} п.п.`;

// ---------- content ----------
const title=[
  new Paragraph({spacing:{before:3600,after:200},alignment:AlignmentType.CENTER,children:[new TextRun({text:"ЭКСПЕРИМЕНТАЛЬНЫЙ ОТЧЁТ",font:FONT,size:22,bold:true,color:C.muted})]}),
  new Paragraph({spacing:{after:240},alignment:AlignmentType.CENTER,children:[new TextRun({text:"Ablation-исследование на JavaBench",font:FONT,size:46,bold:true,color:C.accent})]}),
  new Paragraph({spacing:{after:160},alignment:AlignmentType.CENTER,children:[new TextRun({text:"Вклад итеративной отладки, QKV-памяти и RAG в качество генерации Java-кода",font:FONT,size:26,color:C.text})]}),
  new Paragraph({spacing:{before:1400},alignment:AlignmentType.CENTER,children:[new TextRun({text:`Модель: ${r.model}  •  подвыборка: ${N} задач  •  матрица 2³ = ${names.length} конфигов`,font:FONT,size:22,color:C.muted})]}),
  new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:`Прогон: ${new Date(r.createdAt).toLocaleString("ru-RU")}`,font:FONT,size:20,color:C.muted})]}),
];

const baseline=cfg["it0_mem0_rag0"];
const dItComp=avgDelta("comp","iterative"), dRagComp=avgDelta("comp","rag"), dMemComp=avgDelta("comp","memory");
const dItPass=avgDelta("pass","iterative"), dRagPass=avgDelta("pass","rag"), dMemPass=avgDelta("pass","memory");

const sec1=[
  H1("1. Резюме"),
  P("Цель эксперимента — измерить, насколько каждый из трёх механизмов плагина (итеративная отладка, QKV-память поиска похожих решений, RAG-обогащение контекста) улучшает или ухудшает результат на бенчмарке JavaBench. Полная факторная матрица 2³ = 8 конфигураций прогнана на фиксированной подвыборке из " + N + " задач (по 5 на проект PA19–PA22)."),
  P("Главный вывод: по метрике pass@1 (доля задач, прошедших все тесты) сигнал отсутствует — все конфигурации лежат в диапазоне " + Math.min(...order.map(n=>cfg[n].pass)) + "–" + Math.max(...order.map(n=>cfg[n].pass)) + " из " + N + ". Однако это артефакт метрики, а не отсутствие эффекта механизмов.", {}),
  Pr(b("Реальный сигнал виден на стадии компиляции: "), run(`итеративная отладка ${ppc(avgDelta("compRate","iterative"))}, RAG ${ppc(avgDelta("compRate","rag"))} к доле компилирующегося кода; QKV-память ${ppc(avgDelta("compRate","memory"))} (практически ноль).`)),
  P("Причина расхождения — несоответствие механизма и метрики: итеративная отладка (по дизайну, без утечки тестов) и QKV-память работают на стадии компиляции, тогда как pass@1 определяется логической корректностью тестов. Механизмы переводят код из «не компилируется» в «компилируется, но логика неверна», и выигрыш не доходит до pass@1 на данной модели."),
  H2("Ключевые цифры"),
  table(["Показатель","Значение"],[
    ["Базовый pass@1 (всё выкл)", `${baseline.pass}/${N} (${pct(baseline.passRate)})`],
    ["Базовая доля компиляции", `${baseline.comp}/${N} (${pct(baseline.compRate)})`],
    ["Δ компиляции от итеративной отладки", ppc(avgDelta("compRate","iterative"))],
    ["Δ компиляции от RAG", ppc(avgDelta("compRate","rag"))],
    ["Δ компиляции от QKV-памяти", ppc(avgDelta("compRate","memory"))],
    ["Δ pass@1 от любой опции", "≈ 0 (в пределах шума)"],
    ["Задач: всегда/никогда/«качели»", `${buckets.always.length} / ${buckets.never.length} / ${buckets.swing.length}`],
    ["Всего LLM-вызовов / время", `${totalCalls} / ≈${Math.round(totalSec/60)} мин`],
  ],[5200,4880]),
];

const sec2=[
  H1("2. Цель и гипотезы"),
  P("Плагин совмещает три механизма, каждый из которых теоретически должен повышать качество автономной генерации кода. Эксперимент проверяет их индивидуальный и совместный вклад."),
  H2("Проверяемые механизмы"),
  num([b("Итеративная отладка. "),run("Агент в цикле собирает проект и реагирует на ошибки сборки, исправляя код. Гипотеза: снижает долю несобирающегося кода и повышает pass@1.")]),
  num([b("QKV-память (поиск похожих решений). "),run("По истории применённых diff находит семантически близкие прошлые изменения и предсказывает вероятные падения. Гипотеза: предупреждает повторение ошибок между похожими задачами.")]),
  num([b("RAG. "),run("Подтягивание импортируемых классов и связанных исходников в контекст модели. Гипотеза: модель точнее использует типы и сигнатуры, меньше ошибок компиляции.")]),
  H2("Дизайн"),
  P("Полный факторный план 2³ позволяет оценить и индивидуальный вклад каждой оси (усреднением по парам, где две другие оси зафиксированы), и их взаимодействия."),
];

const sec3=[
  H1("3. Методология"),
  H2("3.1 Бенчмарк"),
  Pr(run("JavaBench (ASE 2024, "),codeR("github.com/java-bench/JavaBench"),run(") — генерация объектно-ориентированного Java-кода уровня проекта: 4 проекта (PA19–PA22), классы со скелетами и "),codeR("// TODO"),run(", оценка тестовыми наборами JUnit. Сборка — Gradle 8.2.")),
  Pr(run("Использован вариант "),b("minimum-context"),run(": модель получает только скелет целевого класса. Это изолирует ось RAG — контекст добавляет наш ContextCollector, который мы и включаем/выключаем (в maximum-context контекст «зашит» в промпт и ось RAG смазалась бы).")),
  H2("3.2 Запуск агента (headless)"),
  P("Ядро агента запускается без VS Code: модуль vscode подменяется шимом (перехват require(\"vscode\")), что позволяет массово прогонять плагин по бенчмарку. Скоринг выполняется официальным evaluation.py (режим class-wise): сгенерированный класс внедряется в каноническое решение, проект компилируется и прогоняются все тесты."),
  H2("3.3 Защита от утечки тестов"),
  P("Грейдинг-тесты исключены из рабочей копии агента (каталог src/test не копируется). Поэтому ни RAG, ни итеративная отладка не видят тесты, по которым потом оценивается решение. Итеративная отладка по умолчанию использует только компиляцию (gradlew compileJava), без запуска грейдинг-тестов — иначе агент переобучался бы на метрику."),
  H2("3.4 Карта осей на тумблеры"),
  table(["Ось","ВКЛ","ВЫКЛ"],[
    ["Итеративная отладка","инструменты сборки доступны, до 8 итераций, разрешён gradlew compileJava","инструменты сборки убраны, до 3 итераций"],
    ["QKV-память","memory.enabled=true + наполнение значения через compile-probe харнесса","memory.enabled=false"],
    ["RAG","context.maxImportedFiles=8, maxTests=6","оба = 0 (только активный файл)"],
  ],[2400,4040,3640]),
  H2("3.5 Параметры прогона"),
  table(["Параметр","Значение"],[
    ["Модель", r.model],
    ["Метрика", "pass@1 (один greedy-сэмпл; компиляция → тесты)"],
    ["Подвыборка", `${N} задач, по 5 на проект PA19–PA22 (зафиксированы в subset.json)`],
    ["Критерий pass", "compile_errors == 0 и пройдены все тесты (n_pass == n_total > 0)"],
    ["Окружение", "JDK 17 (Gradle 8.2), Node 22, Python venv для evaluation.py"],
  ],[3200,6880]),
];

const passRows = order.map((n)=>{const c=cfg[n];return [
  {t:n,align:AlignmentType.LEFT},{t:yn(c.axes.iterative)},{t:yn(c.axes.memory)},{t:yn(c.axes.rag)},
  {t:`${c.comp}/${N}`},{t:`${c.pass}/${N}`,bold:true,color:c.pass>baseline.pass?C.good:(c.pass<baseline.pass?C.bad:C.text)},
];});
const sec4=[
  H1("4. Результаты"),
  H2("4.1 Сводная таблица (компиляция и pass@1)"),
  table(["Конфигурация","Итер.","Память","RAG","Компиляция","pass@1"],passRows,[2700,1100,1300,1100,1950,1930]),
  P("Доля компиляции = доля задач с нулём ошибок компиляции. pass@1 = доля задач, прошедших все тесты."),
  H2("4.2 Средний вклад каждой оси"),
  P("Усреднение разности (ВКЛ − ВЫКЛ) по 4 парам конфигов, где две другие оси зафиксированы."),
  table(["Опция","Δ компиляции","Δ pass@1"],[
    [{t:"Итеративная отладка",align:AlignmentType.LEFT},{t:ppc(avgDelta("compRate","iterative")),bold:true,color:C.good},{t:ppc(avgDelta("passRate","iterative"))}],
    [{t:"RAG",align:AlignmentType.LEFT},{t:ppc(avgDelta("compRate","rag")),bold:true,color:C.good},{t:ppc(avgDelta("passRate","rag"))}],
    [{t:"QKV-память",align:AlignmentType.LEFT},{t:ppc(avgDelta("compRate","memory")),color:C.warn},{t:ppc(avgDelta("passRate","memory"))}],
  ],[4080,3000,3000]),
  Pr(b("Чтение результата: "),run("итеративная отладка и RAG сильно — на ~"+Math.round(100*avgDelta("compRate","iterative"))+" п.п. — повышают долю компилирующегося кода. QKV-память на компиляцию не влияет (около нуля, локально даже слегка отрицательно). По pass@1 ни одна опция не даёт значимого сдвига.")),
  H2("4.3 Структура задач"),
  P(`Из ${N} задач: ${buckets.always.length} проходят во всех конфигах (тривиальные), ${buckets.never.length} не проходят ни в одном (модель не справляется с логикой), ${buckets.swing.length} «качаются» между конфигами.`),
  table(["Категория","Кол-во","Задачи"],[
    [{t:"Всегда pass",align:AlignmentType.LEFT},{t:String(buckets.always.length)},{t:buckets.always.join(", ")||"—",align:AlignmentType.LEFT}],
    [{t:"«Качели»",align:AlignmentType.LEFT},{t:String(buckets.swing.length)},{t:buckets.swing.join(", ")||"—",align:AlignmentType.LEFT}],
    [{t:"Никогда pass",align:AlignmentType.LEFT},{t:String(buckets.never.length)},{t:buckets.never.join(", ")||"—",align:AlignmentType.LEFT}],
  ],[2100,1100,6880]),
  P("«Качели» — это задачи, где исход определяется попаданием на границу компиляция/тест и случайностью генерации; именно они создают видимость различий ±1 задача между конфигами."),
  H2("4.4 Стабильность и стоимость"),
  table(["Конфигурация","LLM-вызовы","Время, с","Ошибки агента"],order.map((n)=>{const c=cfg[n];return [
    {t:n,align:AlignmentType.LEFT},{t:String(c.calls)},{t:String(c.sec)},{t:String(c.errs),color:c.errs?C.warn:C.text},
  ];}),[3480,2200,2200,2200]),
  Pr(run("Итого "),b(`${totalCalls} LLM-вызовов`),run(` и ≈${Math.round(totalSec/60)} минут на всю матрицу. Важное наблюдение: итеративные конфиги (it1·*) дают по 3–7 ошибок агента на 20 задач, тогда как неитеративные — ноль. Многошаговый tool-use с этой моделью менее стабилен (обрывы цикла, ошибки инструментов, таймауты сборки).`)),
];

const sec5=[
  H1("5. Анализ"),
  H2("5.1 Почему pass@1 не двигается"),
  num([b("Несоответствие механизма и метрики. "),run("Итеративная отладка (только компиляция) и QKV-память (запись компиляционных ошибок) бьют в стадию сборки. pass@1 же гейтится логикой тестов. Механизмы переводят задачи из «не компилируется» в «компилируется, но тест падает», и выигрыш не конвертируется в pass@1.")]),
  num([b("Логический пол модели. "),run(`${buckets.never.length} из ${N} задач не решаются ни в одном конфиге — модель ${r.model} не вытягивает их логику независимо от обвязки. Эти задачи нельзя «дотянуть» механизмами сборки.`)]),
  num([b("Статистический шум. "),run(`При ${N} задачах одна задача = 5 п.п. Наблюдаемые различия (±1 задача) лежат в пределах биномиального доверительного интервала: для 4/20 95%-ный ДИ ≈ 8–42%. Поэтому средние Δ pass@1 в точности сокращаются до нуля (выигрыши +5 и проигрыши −5 на «качелях» взаимно гасятся).`)]),
  H2("5.2 Почему итеративная отладка и RAG помогают компиляции"),
  bullet("RAG даёт модели реальные сигнатуры и типы соседних классов — меньше обращений к несуществующим символам и неверных сигнатур, отсюда падение доли ошибок компиляции."),
  bullet("Итеративная отладка позволяет агенту увидеть ошибку javac и переписать код — прямой механизм устранения компиляционных дефектов."),
  bullet("При совместном включении доля компиляции достигает ~85–90% против 50% базлайна — стадия компиляции практически «закрыта», узким местом остаётся логика."),
  H2("5.3 Почему QKV-память не дала эффекта"),
  bullet("Память хранит компиляционные ошибки прошлых diff. Между 20 независимыми задачами кросс-задачное сходство по таким ошибкам низкое — предсказывать почти нечего."),
  bullet("Сигнал памяти полезнее всего там, где повторяются однотипные ошибки; в JavaBench-подвыборке этого паттерна мало."),
  bullet("Локально память даже слегка снижает компиляцию (например, конфиг it0·mem1·rag0 — 8/20 против 10/20 базлайна): инжект предсказаний иногда уводит модель в сторону. Эффект в пределах шума, но направление стоит отметить."),
];

const sec6=[
  H1("6. Угрозы валидности"),
  bullet([b("Малая выборка. "),run(`${N} задач; 1 задача = 5 п.п., доверительные интервалы широкие. Различия по pass@1 статистически не отличимы.`)]),
  bullet([b("Один сэмпл, одна модель. "),run("pass@1 (greedy), без pass@k и без разброса по моделям — не отделяет шум генерации.")]),
  bullet([b("Дизайн без утечки нейтрализует итеративную отладку для pass@1. "),run("Запрет на запуск грейдинг-тестов корректен методологически, но лишает механизм возможности влиять на тест-метрику.")]),
  bullet([b("Память: зависимость от порядка и harness-probe. "),run("Накопление по задачам зависит от порядка (зафиксирован), значение наполняется compile-probe харнесса, а не реальным прогоном тестов.")]),
  bullet([b("Эвристики ядра. "),run("Java-парсер на brace-tracking и текстовый граф вызовов в памяти — приблизительные; на нестандартном коде возможны неточности.")]),
  bullet([b("Нестабильность итеративного режима. "),run("3–7 ошибок агента на конфиг в итеративных прогонах могли занизить их вклад.")]),
];

const sec7=[
  H1("7. Выводы"),
  num("По pass@1 на данной модели и подвыборке ни одна из трёх опций не даёт статистически значимого эффекта — результат в пределах шума."),
  num([run("Это объясняется несоответствием метрики и механизмов, а не их бесполезностью: "),b("итеративная отладка и RAG существенно (~+21 п.п.) повышают долю компилирующегося кода"),run("; их вклад «съедается» на стадии логических тестов.")]),
  num("QKV-память на данной подвыборке нейтральна (около нуля), так как кросс-задачное сходство компиляционных ошибок низкое."),
  num("Узкое место — логическая корректность, которую текущая обвязка (компиляция-only) не адресует; именно сюда нужно направлять улучшения."),
];

const sec8=[
  H1("8. Рекомендации"),
  H2("8.1 Метрика"),
  bullet("Перейти к прогрессивным метрикам JavaBench (completion → компиляция → тесты) и отчитываться по доле компиляции наравне с pass@1 — именно там виден вклад итеративной отладки и RAG."),
  H2("8.2 Чтобы двигать pass@1"),
  bullet("Сделать итеративную отладку тест-реактивной: держать held-out подмножество тестов для итерации, грейдить остальными (компромисс между сигналом и утечкой)."),
  bullet("Поднять логический потолок более сильной моделью — на gpt-4o-mini compile-сигнал уже исчерпан, тест-сигнал упёрся в способности модели."),
  H2("8.3 Статистическая мощность"),
  bullet(`Увеличить выборку до полного набора (45 задач) и/или перейти к pass@k (k сэмплов, температура ~0.2) для снижения дисперсии.`),
  H2("8.4 Память"),
  bullet("Проверить память на сценариях с повторяющимися ошибками (серия похожих правок одного проекта), где её сигнал должен проявиться сильнее; рассмотреть запись логических (тестовых), а не только компиляционных падений."),
];

const sec9=[
  H1("Приложение A. Воспроизводимость"),
  P("Окружение и фиксированные параметры прогона:"),
  ...codeBlock([
    `model            : ${r.model}`,
    `tasks (subset)   : ${N} (5 per project PA19–PA22, see subset.json)`,
    `matrix           : 2^3 = ${names.length} configs (iterative × memory × rag)`,
    `metric           : pass@1, criterion compile_errors==0 && n_pass==n_total>0`,
    `scoring          : JavaBench evaluation.py class-wise (Gradle 8.2 + JDK 17)`,
    `agent            : headless via vscode-shim, no editor UI`,
    `leakage guard    : src/test excluded; iterative = compileJava only`,
    `total LLM calls  : ${totalCalls}`,
    `total wall time  : ~${Math.round(totalSec/60)} min`,
    `generated        : ${r.createdAt}`,
  ]),
  P("Команды запуска: node run-ablation.js (генерация + скоринг) → node report.js (сводка). Подробности — bench/README.md."),
];

const doc = new Document({
  styles:{ default:{document:{run:{font:FONT,size:22,color:C.text}}},
    paragraphStyles:[
      {id:"Heading1",name:"Heading 1",basedOn:"Normal",next:"Normal",quickFormat:true,run:{font:FONT,size:34,bold:true,color:C.accent},paragraph:{spacing:{before:340,after:180},outlineLevel:0}},
      {id:"Heading2",name:"Heading 2",basedOn:"Normal",next:"Normal",quickFormat:true,run:{font:FONT,size:27,bold:true},paragraph:{spacing:{before:280,after:140},outlineLevel:1}},
      {id:"Heading3",name:"Heading 3",basedOn:"Normal",next:"Normal",quickFormat:true,run:{font:FONT,size:23,bold:true},paragraph:{spacing:{before:220,after:110},outlineLevel:2}},
    ]},
  numbering:{config:[
    {reference:"b",levels:[{level:0,format:LevelFormat.BULLET,text:"•",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:520,hanging:260}}}}]},
    {reference:"n",levels:[{level:0,format:LevelFormat.DECIMAL,text:"%1.",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:520,hanging:340}}}}]},
  ]},
  sections:[{
    properties:{page:{size:{width:PAGE_W,height:PAGE_H},margin:{top:MARGIN,right:MARGIN,bottom:MARGIN,left:MARGIN}}},
    headers:{default:new Header({children:[new Paragraph({alignment:AlignmentType.RIGHT,children:[new TextRun({text:"JavaBench ablation — экспериментальный отчёт",font:FONT,size:17,color:C.muted,italics:true})]})]})},
    footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:"Стр. ",font:FONT,size:17,color:C.muted}),new TextRun({children:[PageNumber.CURRENT],font:FONT,size:17,color:C.muted}),new TextRun({text:" из ",font:FONT,size:17,color:C.muted}),new TextRun({children:[PageNumber.TOTAL_PAGES],font:FONT,size:17,color:C.muted})]})]})},
    children:[...title,pb(),...sec1,pb(),...sec2,...sec3,pb(),...sec4,pb(),...sec5,...sec6,pb(),...sec7,...sec8,pb(),...sec9],
  }],
});

Packer.toBuffer(doc).then((buf)=>{ fs.writeFileSync(OUT,buf); console.log("Wrote:",OUT,buf.length,"bytes"); });
