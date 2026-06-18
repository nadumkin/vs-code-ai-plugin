# START — запуск и использование

Гайд по поднятию бэкенда и работе с плагином. Обзор архитектуры — в [README.md](README.md).

## Требования
- **Docker Desktop** (запущен) — для сервера.
- **Node.js 18+** и **VS Code** — для плагина.
- (опционально) **Python 3.10+** — для автономного тест-клиента.
- (опционально) **NVIDIA-хост + nvidia-container-toolkit** — для локальной Qwen MoE на CUDA.

---

## Шаг 1. Запустить бэкенд

```bash
cd server
docker compose up --build -d        # поднимет postgres, rabbitmq, proxy, request, llm
docker compose ps                   # дождаться, пока postgres и rabbitmq станут healthy
```

По умолчанию активна офлайн-модель `mock/echo` — **ключи не нужны**.

Порты на хосте: Proxy `8000`, Request (WS) `8090`, RabbitMQ UI `15672` (guest/guest), Postgres `5432`.

> Если порт занят (`port is already allocated`) — поменяйте маппинг в `server/docker-compose.yml`
> (см. раздел «Если что-то не так» ниже).

---

## Шаг 2. Проверить, что всё работает

**Health и список моделей:**
```bash
curl http://localhost:8000/health        # {"status":"ok"}
curl http://localhost:8000/v1/models     # {"models":[{"id":"mock/echo",...},{"id":"openai/gpt-5.2",...}]}
```

**Полный пайплайн без VS Code** (POST → requestId → WebSocket → ответ):
```bash
pip install httpx websockets             # один раз

python test_client.py                            # connect-before
python test_client.py --delay 5                  # connect-after (ответ ждёт в БД)
python test_client.py --prompt "Привет, очередь!"
python test_client.py --token wrong              # негатив: 401 / WS отклонён
```

Ожидаемый ответ — OpenAI-формат с текстом `"[echo] <ваш промпт>"`.

---

## Шаг 3. Подключить плагин

1. Установить зависимость `ws` (плагину нужен WebSocket-клиент):
   ```bash
   cd vs-ext-ai-plugin
   npm install
   ```
2. Открыть папку `vs-ext-ai-plugin` в VS Code и нажать **F5** — откроется окно
   **Extension Development Host** с загруженным плагином.
3. В этом окне открыть панель агента (значок **Agent** на activity bar) → **AI Agent: Open Settings** (значок «Настройки»):
   - нажать **«Загрузить модели»** → выпадающий список заполнится с сервера;
   - выбрать модель (например `mock/echo`);
   - в поле **API key** вписать токен доступа — по умолчанию `dev-secret-token-123` (из `server/tokens.json`);
   - **Сохранить**.
4. Ввести запрос в поле и отправить — ответ придёт через бэкенд (echo вернёт текст без реальной модели).

Адреса бэкенда уже стоят по умолчанию; при необходимости их можно переопределить в `settings.json`:
```json
{
  "aiAgentAssistant.backend.httpUrl": "http://localhost:8000",
  "aiAgentAssistant.backend.wsUrl": "ws://localhost:8090",
  "aiAgentAssistant.openRouter.model": "mock/echo"
}
```

> Кастомную модель не из списка можно задать прямо в `aiAgentAssistant.openRouter.model`.
> Сборка `.vsix` сейчас исключает `node_modules` (`.vscodeignore`) — для упаковки нужен бандлинг
> или временное снятие исключения; для разработки через **F5** всё работает как есть.

---

## Реальная модель через OpenRouter (опционально)

1. Прописать ключ:
   ```bash
   cd server
   cp .env.example .env        # вписать OPENROUTER_KEY=...
   docker compose up -d --build --force-recreate llm
   ```
2. В настройках плагина выбрать модель `openai/gpt-5.2`. Здесь работает и tool-calling
   (агент сможет читать/писать файлы и запускать команды).

---

## Qwen MoE на CUDA (только GPU-хост)

На машине с NVIDIA GPU (Linux + nvidia-container-toolkit):

```bash
cd server
docker compose -f docker-compose.yml -f docker-compose.cuda.yml up --build -d

curl http://localhost:8000/v1/models                  # появится qwen/qwen1.5-moe-a2.7b-chat
docker logs server-llm-1 | grep "device auto-check"   # device: cuda
```

Веса (`Qwen/Qwen1.5-MoE-A2.7B-Chat`, ~28 ГБ fp16) скачиваются один раз в том `hf_cache` при первом запросе.
Затем выберите модель `qwen/qwen1.5-moe-a2.7b-chat` в настройках плагина.

> На Docker Desktop для Mac GPU недоступен — этот режим только для отдельной GPU-машины.
> На Mac пользуйтесь `mock/echo` (или `openrouter`).

---

## Полезные команды

```bash
cd server

# логи
docker compose logs -f                       # всё
docker logs -f server-llm-1                  # конкретный сервис (proxy/request/llm/rabbitmq/postgres)

# очередь RabbitMQ — веб-интерфейс
open http://localhost:15672                  # guest / guest

# лог запросов в БД
docker exec server-postgres-1 psql -U aiplugin -d aiplugin \
  -c "select left(request_id,10) req, model, status, created_at from requests order by created_at desc limit 10;"

# остановить / перезапустить
docker compose down                          # остановить (БД сохраняется в томе)
docker compose down -v                       # остановить и стереть данные БД + кэш
docker compose up -d --build --force-recreate proxy llm   # пересобрать только эти сервисы
```

---

## Если что-то не так

| Симптом | Что делать |
|---|---|
| `port is already allocated` при `up` | Порт занят другим процессом/контейнером. В `server/docker-compose.yml` поменяйте левую часть маппинга (host-порт), напр. `"8090:8081"` → `"8095:8081"`, и синхронно `aiAgentAssistant.backend.wsUrl` в плагине. |
| Плагин: `Не найден access token` | В **AI Agent: Open Settings** сохраните токен из `server/tokens.json` (`dev-secret-token-123`). |
| Плагин: `401` / WS отклонён | Токен не совпадает с `server/tokens.json`. Файл перечитывается без рестарта — поправьте и повторите. |
| В списке моделей нет `qwen/...` | Это норма для CPU-образа (нет `torch`). MoE доступна только в CUDA-сборке на GPU-хосте. |
| `LLM service unavailable` на `/v1/models` | LLM-сервис ещё стартует или упал — проверьте `docker logs server-llm-1`. |
| Изменения в коде сервера не подхватились | `docker compose up -d --build --force-recreate <service>` (просто `up` иногда не пересоздаёт контейнер). |
