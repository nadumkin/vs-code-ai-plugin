# JavaBench ablation harness

Измеряет вклад трёх механизмов плагина в pass@1 на JavaBench:
**итеративная отладка**, **QKV-память** (поиск похожих решений), **RAG** (подтягивание контекста).
Полная матрица 2³ = 8 конфигов на подвыборке из 20 задач (5 на проект PA19–PA22).

Плагин запускается **headless** — ядро агента (`../src/*`) загружается через
`vscode`-шим (`register-shim.js` перехватывает `require("vscode")`), без VS Code и без UI.
Скоринг — официальным `JavaBench/evaluation.py` (`class-wise`).

## Окружение (уже настроено в этой машине)

- JDK 17: `/opt/homebrew/opt/openjdk@17` (Gradle 8.2 не поддерживает Java 25).
- Python venv: `bench/.venv` с `click`, `pandas`, `tree-sitter==0.21.3`, `tree-sitter-languages==1.10.2`.
- Стаб `bench/pystubs/langchain` — гасит inference-only импорт в `evaluation.py` (скоринг не тянет тяжёлый стек).
- `bench/node_modules` — `fast-glob` для шима.
- `bench/JavaBench` — клон бенчмарка.

## Запуск

```bash
cd bench
export OPENROUTER_API_KEY=sk-or-...           # обязательно
export BENCH_MODEL=openai/gpt-4o-mini         # любая модель с tool calling (по умолчанию gpt-4o-mini)
# опционально: export BENCH_BASE_URL=...  BENCH_JAVA_HOME=...  BENCH_ONLY=it1_mem1_rag1,it0_mem0_rag0

node run-ablation.js     # генерация 8×20 + скоринг → results.json
node report.js           # таблица pass@1 + вклад осей → report.md / report.csv
```

Прогон последовательный (память накапливается по задачам внутри конфига и зависит от порядка).
Ориентир: 8 конфигов × 20 задач = 160 прогонов агента; iterative-конфиги делают по нескольку
LLM-витков + `gradlew compileJava`. Стоимость по токенам и время зависят от модели.

Быстрая проверка без затрат:
```bash
node smoke.js            # no-LLM: проверяет шим, материализацию, RAG-оси, фильтр инструментов
```

## Что считается pass

`compile_errors == 0 && n_pass == n_total && n_total > 0` (из `evaluation.py class-wise`).

## Карта осей → тумблеры

| Ось | ON | OFF |
|---|---|---|
| Итеративная отладка | tools с `run_shell_command`/`run_bash_script`, `maxIterations=8`, разрешён `gradlew compileJava` | эти tools убраны, `maxIterations=3` |
| QKV-память | `memory.enabled=true` + harness compile-probe наполняет value | `memory.enabled=false` |
| RAG | `context.maxImportedFiles=8`, `context.maxTests=6` | оба `=0` |

Тесты грейдинга **исключены** из рабочей копии агента (`src/test` не копируется), поэтому ни RAG,
ни итеративная отладка не видят грейдинг-тесты — утечки нет. Скоринг приносит свои тесты через
`TestEnv` (`projects/PA{n}-Solution`).

## Файлы

- `vscode-shim.js` / `register-shim.js` — headless `vscode`.
- `javabench-adapter.js` — загрузка задач, материализация workspace, извлечение `completion`.
- `agent-driver.js` — один прогон (задача × конфиг).
- `configs.js` — матрица 2³. `subset.json` — фиксированная подвыборка.
- `run-ablation.js` — оркестратор (+ скоринг). `report.js` — отчёт.
- `results.json` / `report.md` / `report.csv` — результаты (после прогона).
