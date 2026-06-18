# Backend для VS Code AI-плагина

Асинхронный бэкенд из четырёх сервисов + БД + очередь, по диаграмме:

```
Plugin ──POST /v1/requests──► Proxy ──"requests"──► LLM Service ──"responses"──► Request ──WS──► Plugin
                               │  (Postgres: лог запроса)   │ (Postgres: ответ)       ▲
                               └────────────► Postgres ◄─────┘                         │
                                                  └─────────── читает ответ ───────────┘
```

| Сервис | Стек | Порт | Роль |
|---|---|---|---|
| **Proxy Service** | FastAPI | `8000` | Проверяет токен, пишет запрос в БД, кладёт в очередь `requests`, отдаёт `requestId` |
| **Request Service** | FastAPI + WebSocket | `8090`→`8081` | WS по `requestId`; читает `responses`; отдаёт ответ (в т.ч. если он уже готов) |
| **LLM Service** | FastAPI + воркер | `8002` (внутр.) | Читает `requests`, гоняет модель через **адаптеры**, пишет ответ в БД, шлёт в `responses` |
| **Queue** | RabbitMQ | `5672` / UI `15672` | Очереди `requests` и `responses` |
| **Database** | Postgres | `5432` | Лог запросов (запрос + статус + ответ) |

## Запуск

```bash
cd server
cp .env.example .env          # при желании впишите OPENROUTER_KEY
docker compose up --build     # дождитесь, пока postgres и rabbitmq станут healthy
```

По умолчанию активна офлайн-модель `mock/echo` (эхо последнего сообщения) — ключи не нужны.

## Проверка пайплайна (без VS Code)

```bash
pip install httpx websockets

# connect-before: WS открывается, пока ответ ещё считается
python test_client.py

# connect-after: ответ уже лежит в БД к моменту подключения WS
python test_client.py --delay 5

# реальная модель (нужен OPENROUTER_KEY в .env)
python test_client.py --model openai/gpt-5.2 --prompt "Write a haiku about queues"

# негатив: неверный токен -> Proxy 401 / WS close(1008)
python test_client.py --token wrong
```

Очередь видно в RabbitMQ UI: <http://localhost:15672> (guest / guest).
Логи запросов в БД:

```bash
docker compose exec postgres psql -U aiplugin -d aiplugin \
  -c "select request_id, model, status, created_at from requests order by created_at desc limit 5;"
```

## Токены доступа

Общий файл `tokens.json` монтируется (read-only) в Proxy и Request Service и проверяется обоими.
Формат:

```json
{ "tokens": [ { "token": "dev-secret-token-123", "name": "local-dev" } ] }
```

Файл перечитывается при изменении mtime — правки подхватываются без рестарта.

## Модели (паттерн Адаптер)

`models.json` задаёт, какие модели «подняты» и каким адаптером обслуживаются. Все адаптеры
реализуют один интерфейс `BaseModelAdapter.generate(ChatRequest) -> OpenAI chat.completion`,
поэтому вход/выход одинаков независимо от бэкенда.

```json
{
  "default": "mock/echo",
  "models": [
    { "id": "mock/echo", "adapter": "echo" },
    { "id": "openai/gpt-5.2", "adapter": "openrouter", "params": { "upstream_model": "openai/gpt-5.2" } },
    { "id": "qwen/qwen1.5-moe-a2.7b-chat", "adapter": "hf_local", "params": { "model_path": "Qwen/Qwen1.5-MoE-A2.7B-Chat", "max_new_tokens": 256 } }
  ]
}
```

Адаптеры (`llm_service/adapters/`):
- **echo** — офлайн-заглушка, ничего не требует;
- **openrouter** — форвардит запрос в OpenAI-совместимый API (`OPENROUTER_KEY`), tool-calling работает нативно;
- **hf_local** — локальная HuggingFace-модель. Требует `torch` (есть только в CUDA-образе, см. ниже);
  если torch недоступен, реестр **пропускает** такие модели — они не попадают в список.

Несколько записей могут указывать на один адаптер с разными `params` — так сервис «поднимает несколько моделей».

### Список моделей (`GET /v1/models`)
LLM Service отдаёт зарегистрированные модели; Proxy проксирует их на `GET http://localhost:8000/v1/models`
(без токена). Плагин дергает этот эндпоинт по кнопке «Загрузить модели» в настройках и наполняет `<select>`.

```bash
curl http://localhost:8000/v1/models
# {"models":[{"id":"mock/echo","adapter":"echo","default":true}, ...]}
```

### Локальная Qwen MoE на CUDA
Модель `qwen/qwen1.5-moe-a2.7b-chat` (Qwen1.5-MoE-A2.7B-Chat, 14.3B весов / 2.7B активных) идёт через
`hf_local` и запускается только на **NVIDIA-хосте** (Linux + nvidia-container-toolkit):

```bash
docker compose -f docker-compose.yml -f docker-compose.cuda.yml up --build -d
curl http://localhost:8000/v1/models                 # появится qwen/qwen1.5-moe-a2.7b-chat (hf_local)
docker logs server-llm-1 | grep "device auto-check"  # device: cuda
```

Устройство определяется автоматически при старте (CUDA→MPS→CPU) и логируется («device auto-check»),
видно и в `GET /health`. Веса (~28 ГБ fp16) скачиваются один раз в том `hf_cache` при первом запросе.

> На Docker Desktop для Mac GPU недоступен (нет проброса Metal/CUDA): базовый стек работает на CPU
> с `mock/echo`/`openrouter`, а CUDA+MoE запускайте на отдельной GPU-машине.

## Подключение плагина

В настройках VS Code (`settings.json` рабочей области или глобально):

```json
{
  "aiAgentAssistant.backend.httpUrl": "http://localhost:8000",
  "aiAgentAssistant.backend.wsUrl": "ws://localhost:8090",
  "aiAgentAssistant.openRouter.model": "mock/echo"
}
```

Модель выбирается из выпадающего списка: в **AI Agent: Open Settings** нажмите «Загрузить модели»
(запрос к Proxy `GET /v1/models`), выберите модель и сохраните.

Токен доступа сохраняется как и раньше — через **AI Agent: Open Settings** (поле API key);
он отправляется в `Authorization: Bearer <token>` на Proxy и в `?token=` на WebSocket.
Значение должно совпадать с одним из токенов в `tokens.json` (например `dev-secret-token-123`).

> Плагину нужен npm-пакет `ws`: в каталоге `vs-ext-ai-plugin/` выполните `npm install`.
> Запуск через F5 (Extension Development Host) подхватит `node_modules`. Для сборки `.vsix`
> `node_modules` сейчас исключён в `.vscodeignore` — потребуется бандлинг или временное снятие исключения.
