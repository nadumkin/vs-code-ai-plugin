# Установка плагина AI Agent Assistant

Инструкция предназначена для разработчика-заказчика. Плагин — расширение VS Code на чистом JavaScript, без шага сборки и без npm-зависимостей в runtime.

## 1. Требования

| Компонент | Минимальная версия | Зачем |
|---|---|---|
| **VS Code** | 1.90 | Хост расширения |
| **Node.js** | 18+ | `node --check` при валидации; runtime берётся из VS Code |
| **Git** | любая | Клонирование репозитория |
| **JDK** *(опционально)* | 17+ | Запуск `javap` для байткод-отпечатка в QKV-памяти |
| **Maven / Gradle** *(опционально)* | любой | Сборка Java-проекта; нужно если хочется, чтобы байткод-fingerprint работал на ваших классах |
| **OpenRouter API key** *(или совместимый endpoint)* | — | Доступ к LLM |

JDK и Maven/Gradle обязательны только если вы хотите включить байткод-обогащение `memory.java.bytecodeProbe`. Без них плагин работает в режиме «лексика + Java-AST через собственный парсер»; это покрывает большую часть сценариев.

## 2. Установка

Два способа: dev-режим (быстро, удобно для апдейтов из git) и packaged `.vsix` (для постоянной установки).

### Способ A. Dev-режим через Extension Development Host (рекомендуется)

```bash
# 1. Клонируем репозиторий
git clone https://github.com/nadumkin/vs-ext-java-capsule.git
cd vs-ext-java-capsule

# 2. (опционально) Проверяем, что код не сломан
npm run validate
```

Дальше — открыть в VS Code:

```bash
code .
```

Внутри VS Code:
1. Открыть **Run and Debug** (`Cmd+Shift+D` / `Ctrl+Shift+D`).
2. Нажать **F5**. Откроется новое окно с надписью «Extension Development Host» в заголовке.
3. В этом окне открыть свой Java-проект (`File → Open Folder…`).
4. Перейти в Activity Bar → иконка **Agent**.

Преимущество: при `git pull` и перезапуске EDH вы автоматически получаете обновления.

### Способ B. Установка через `.vsix`

Если не хочется держать второй процесс VS Code, можно собрать отдельный пакет:

```bash
# Установить инструмент упаковки (один раз глобально)
npm install -g @vscode/vsce

# В корне репозитория:
cd vs-ext-java-capsule
vsce package --no-dependencies
# Получится файл vscode-ai-agent-assistant-0.0.1.vsix
```

Установить пакет в обычный VS Code:

```bash
code --install-extension vscode-ai-agent-assistant-0.0.1.vsix
```

Или через UI: **Extensions → ⋯ (вверху панели) → Install from VSIX…** и выбрать файл.

## 3. Первый запуск и настройка

1. В Activity Bar нажмите иконку **Agent** — откроется чат-панель.
2. Нажмите кнопку **Настройки** в верхней панели чата.
3. Заполните поля:

   | Поле | Что писать |
   |---|---|
   | **Endpoint** | `https://openrouter.ai/api/v1/chat/completions` (для OpenRouter) или URL вашего совместимого chat/completions endpoint |
   | **Модель** | Идентификатор модели **с поддержкой function calling**, например `anthropic/claude-sonnet-4.5`, `openai/gpt-4o-mini`, `openai/gpt-5.2`. Модели Gemma function calling не поддерживают |
   | **API key** | Ваш ключ OpenRouter (или другого провайдера). Хранится в **VS Code Secret Storage**, не в файлах проекта |
   | **Лимит итераций** | Сколько LLM-итераций агент может сделать без подтверждения (по умолчанию 8) |
   | **Автоприменять изменения кода** | Если включено, diff не будет показываться для подтверждения. Для первого знакомства лучше оставить выключенным |

4. Нажмите **Сохранить**.

## 4. Проверка работоспособности

1. Откройте любой `.java` файл в EDH.
2. В чат-панели введите что-то простое: «Объясни, что делает этот класс».
3. Должны увидеть:
   - в верхней карточке «Что уходит в модель» — путь файла, обнаруженный класс, число импортов и тестов;
   - ответ агента в чате.

Если получили ответ — endpoint и API key настроены правильно.

## 5. Включение полного QKV-функционала памяти

Память по истории diff включена по умолчанию (`aiAgentAssistant.memory.enabled = true`). Подробное описание архитектуры — в [qkv-memory.md](qkv-memory.md).

### 5.1 Минимально (только лексика + Java-AST)

Никаких дополнительных шагов не нужно. После первого `Apply diff → mvn test` (или `gradle test`, или другой тестовой команды через инструмент агента) в `<workspace>/.aiAgentAssistant/memory/store.json` появится первая запись пары `(key, value)`.

### 5.2 С байткод-отпечатком

Для активации компонента `bytecode` в реранкере нужен JDK с `javap` в PATH:

```bash
# Проверка
javap -version
# Должно вывести что-то вроде "javap 17.0.7"
```

Если установлено — настройка работает в режиме `auto` и сама подхватит компилированные классы из стандартных папок (`target/classes`, `build/classes/java/main`, `out/production/classes`, `bin`). Никаких действий не требуется.

Если ваш проект использует нестандартные пути:

```jsonc
// .vscode/settings.json или User Settings
{
  "aiAgentAssistant.memory.java.classOutputPaths": [
    "build/output/classes",
    "modules/core/target/classes"
  ]
}
```

### 5.3 Тонкая настройка реранкера (опционально)

Веса по умолчанию подобраны эмпирически. Можно переопределить под ваш проект:

```jsonc
{
  "aiAgentAssistant.memory.topK": 5,
  "aiAgentAssistant.memory.rerank.weights.bm25": 1.0,
  "aiAgentAssistant.memory.rerank.weights.methods": 1.2,
  "aiAgentAssistant.memory.rerank.weights.calls": 0.7,
  "aiAgentAssistant.memory.rerank.weights.bytecode": 0.5
}
```

## 6. Полный список настроек

Открывайте через VS Code **Settings → Extensions → AI Agent Assistant** (или редактируйте `settings.json`):

| Ключ | Тип | Значение по умолчанию | Назначение |
|---|---|---|---|
| `openRouter.model` | string | `openai/gpt-5.2` | Идентификатор модели |
| `openRouter.baseUrl` | string | `https://openrouter.ai/api/v1/chat/completions` | URL endpoint |
| `openRouter.requestTimeoutMs` | number | `120000` | Таймаут запроса к LLM |
| `context.maxImportedFiles` | number | `8` | Сколько импортированных файлов прикладывать к промпту |
| `context.maxTests` | number | `6` | Сколько связанных тестовых файлов прикладывать |
| `context.maxFileChars` | number | `16000` | Лимит символов с одного файла |
| `agent.maxIterations` | number | `8` | Сколько LLM-итераций до запроса «Продолжить» |
| `execution.requireConfirmation` | boolean | `true` | Спрашивать подтверждение перед запуском shell/bash |
| `execution.autoApplyFileChanges` | boolean | `false` | Применять правки без diff-предпросмотра |
| `execution.commandTimeoutMs` | number | `120000` | Таймаут shell/bash команд |
| `memory.enabled` | boolean | `true` | Включает QKV-память по истории diff |
| `memory.topK` | number | `3` | Сколько похожих прошлых diff показывать |
| `memory.storagePath` | string | `""` | Кастомный путь к store.json (пусто = `<workspace>/.aiAgentAssistant/memory/store.json`) |
| `memory.java.enabled` | boolean | `true` | Java-AST обогащение (методы, call graph) |
| `memory.java.bytecodeProbe` | enum | `auto` | `auto` / `off` / `force` |
| `memory.java.classOutputPaths` | string[] | `[]` | Где искать `.class` (пусто = стандартные пути Maven/Gradle/IntelliJ/Eclipse) |
| `memory.rerank.enabled` | boolean | `true` | Реранкинг кандидатов после BM25 |
| `memory.rerank.topN` | number | `50` | Размер кандидат-сета для реранкера |
| `memory.rerank.weights.bm25` | number | `1.0` | Вес нормализованного BM25 |
| `memory.rerank.weights.methods` | number | `1.0` | Вес Jaccard по сигнатурам методов |
| `memory.rerank.weights.calls` | number | `0.7` | Вес Jaccard по callers∪callees |
| `memory.rerank.weights.bytecode` | number | `0.5` | Вес Jaccard по байткод-n-граммам |

## 7. Команды плагина

Доступны через **Cmd+Shift+P / Ctrl+Shift+P → AI Agent: …**:

| Команда | Что делает |
|---|---|
| `AI Agent: Open Assistant` | Открыть/сфокусировать чат-панель |
| `AI Agent: Open Settings` | Открыть форму настроек подключения |
| `AI Agent: Clear Chat` | Очистить историю текущего диалога |
| `AI Agent: Refresh Context` | Пересобрать контекст активного файла (импорты, тесты) |

## 8. Что появится при работе

- **Diff-предпросмотр** — при правке файлов агент открывает встроенный VS Code diff-view; внизу чата появляются кнопки **Применить** / **Отклонить**. После Apply изменения записываются на диск.
- **Shell/Bash блоки** — каждая запущенная команда показывается отдельной карточкой с stdout/stderr/exit code/cwd.
- **Memory-блок** — фиолетовая карточка «Предсказание по истории diff» появляется после Apply, если в `store.json` найдены похожие прошлые правки. Включает сводку top-K (частые исключения, общие фреймы) и компонентную разбивку score реранкера.
- **Лимит итераций** — если агент достигает лимита, появляется кнопка **Продолжить** для следующей пачки итераций без потери прогресса.

## 9. Логи и диагностика

При любых проблемах смотрите **View → Output → AI Agent Assistant**. Там пишутся:
- запросы/ответы LLM при ошибках (`[OpenRouterClient] error response (HTTP …)` + полный JSON);
- этапы memory-пайплайна (`[memory] recordPendingApply`, `[memory] pendingQuery created`, `[memory] entry saved`, `[memory] store saved to …`);
- сбои внутри Java-обогащения и байткод-зонда.

## 10. Удаление

Dev-режим: просто закрыть EDH-окно. Никакие файлы не остаются вне репозитория проекта.

`.vsix`-установка:
```bash
code --uninstall-extension local.vscode-ai-agent-assistant
```

API-ключ хранится в Secret Storage VS Code и **не** удаляется автоматически. Для очистки:
```
Cmd+Shift+P → AI Agent: Open Settings → "Удалить сохраненный API key" → Сохранить
```

Файл памяти `<workspace>/.aiAgentAssistant/memory/store.json` остаётся в проекте — удалите вручную, если хотите сбросить накопленную историю.
