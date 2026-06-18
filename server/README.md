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
    { "id": "qwen/qwen2.5-coder-0.5b", "adapter": "hf_local", "params": { "model_path": "Qwen/Qwen2.5-Coder-0.5B-Instruct", "max_new_tokens": 256 } }
  ]
}
```

Адаптеры (`llm_service/adapters/`):
- **echo** — офлайн-заглушка, ничего не требует;
- **openrouter** — форвардит запрос в OpenAI-совместимый API (`OPENROUTER_KEY`), tool-calling работает нативно;
- **hf_local** — локальная HuggingFace-модель. `torch`+`transformers` встроены в образ LLM (`INSTALL_HF=true`),
  устройство определяется авто (CUDA→MPS→CPU). По умолчанию поднята небольшая `qwen/qwen2.5-coder-0.5b`
  (Qwen2.5-Coder-0.5B-Instruct, ~1 ГБ) — работает и на CPU. Если torch недоступен — модель тихо пропускается.

Несколько записей могут указывать на один адаптер с разными `params` — так сервис «поднимает несколько моделей».

### Список моделей (`GET /v1/models`)
LLM Service отдаёт зарегистрированные модели; Proxy проксирует их на `GET http://localhost:8000/v1/models`
(без токена). Плагин дергает этот эндпоинт по кнопке «Загрузить модели» в настройках и наполняет `<select>`.

```bash
curl http://localhost:8000/v1/models
# {"models":[{"id":"mock/echo","adapter":"echo","default":true}, ...]}
```

### Небольшая локальная модель на CPU
`qwen/qwen2.5-coder-0.5b` поднимается прямо в базовом стеке (CPU) — `torch` уже в образе LLM. Веса (~1 ГБ)
скачиваются один раз в том `hf_cache` при первом запросе и дальше берутся из кэша. Первый ответ дольше
(загрузка модели + инференс на CPU), последующие быстрее. Выберите модель в плагине или укажите в запросе:

```bash
curl http://localhost:8000/v1/models     # есть qwen/qwen2.5-coder-0.5b (adapter hf_local)
python test_client.py --model qwen/qwen2.5-coder-0.5b --prompt "Write a Python function fib(n)."
```

### Весь стек на машине с CUDA (крупная модель)
Чтобы гонять модель крупнее — склонируйте репозиторий на **Linux-хост с NVIDIA GPU** и установленным
nvidia-container-toolkit, и поднимите стек с CUDA-override:

```bash
git clone <repo> && cd <repo>/server
docker compose -f docker-compose.yml -f docker-compose.cuda.yml up --build -d
docker logs server-llm-1 | grep "device auto-check"   # device: cuda (+ имя GPU)
curl http://localhost:8000/v1/models                   # список моделей
```

CUDA-override (`docker-compose.cuda.yml`) подменяет образ LLM на `Dockerfile.cuda` (torch+CUDA),
резервирует GPU, монтирует `models.cuda.json` и том `hf_cache`. `hf_local` грузит модель на GPU через
accelerate (`device_map="auto"`, fp16); у крупных моделей tool-calling работает нативно (полный агент,
правки файлов через инструменты — `useTools: true`).

**Выбор модели** — правьте `server/models.cuda.json` (`model_path` = любой HF-репозиторий):

| Модель | VRAM (fp16) | GPU |
|---|---|---|
| `Qwen/Qwen2.5-Coder-7B-Instruct` (готово: `qwen/qwen2.5-coder-7b`) | ~16 ГБ | 16–24 ГБ (3090/4090, A4000+) |
| `Qwen/Qwen2.5-Coder-14B-Instruct` | ~28 ГБ | 24–32 ГБ |
| `Qwen/Qwen2.5-Coder-32B-Instruct` | ~64 ГБ / квантизация | A100 80G или 4-bit |
| `Qwen/Qwen1.5-MoE-A2.7B-Chat` (готово: `qwen/qwen1.5-moe-a2.7b-chat`) | ~28 ГБ, быстрая (2.7B активных) | 24–32 ГБ |

Веса качаются один раз в `hf_cache`. Устройство логируется при старте («device auto-check») и в `GET /health`.

**Плагин:**
- VS Code на той же машине → адреса по умолчанию (`http://localhost:8000`, `ws://localhost:8090`);
- плагин на другом компьютере → в настройках укажите IP CUDA-хоста:
  `aiAgentAssistant.backend.httpUrl = http://<CUDA_IP>:8000`, `…backend.wsUrl = ws://<CUDA_IP>:8090`
  (порты 8000/8090 публикуются в compose; откройте их в фаерволе хоста).

> На Docker Desktop для Mac GPU недоступен — там только CPU (`mock/echo` / `qwen2.5-coder-0.5b`).
> Крупные модели запускайте на отдельной CUDA-машине по инструкции выше.

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

Токен доступа сохраняется через **AI Agent: Open Settings** → поле **«Ключ доступа (Proxy Service)»**;
он отправляется в `Authorization: Bearer <token>` на Proxy и в `?token=` на WebSocket.
Ключ OpenRouter в плагине не задаётся — только на сервере (`OPENROUTER_KEY`).
Значение должно совпадать с одним из токенов в `tokens.json` (например `dev-secret-token-123`).

> Плагину нужен npm-пакет `ws`: в каталоге `vs-ext-ai-plugin/` выполните `npm install`.
> Запуск через F5 (Extension Development Host) подхватит `node_modules`. Для сборки `.vsix`
> `node_modules` сейчас исключён в `.vscodeignore` — потребуется бандлинг или временное снятие исключения.
