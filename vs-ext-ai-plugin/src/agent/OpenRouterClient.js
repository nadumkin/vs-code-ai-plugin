const vscode = require("vscode");
const WebSocket = require("ws");

const SECRET_KEY = "aiAgentAssistant.openRouter.apiKey";

const { NullLogger } = require("../util/Logger");

class OpenRouterClient {
  constructor(secretStorage, outputChannel = null, logger = null) {
    this.secretStorage = secretStorage;
    this.outputChannel = outputChannel;
    this.logger = logger || new NullLogger();
  }

  async getApiKey() {
    return (
      (await this.secretStorage.get(SECRET_KEY)) ||
      process.env.OPENROUTER_API_KEY ||
      ""
    );
  }

  async hasStoredApiKey() {
    return Boolean(await this.getApiKey());
  }

  async storeApiKey(apiKey) {
    const normalized = String(apiKey || "").trim();
    if (!normalized) {
      return false;
    }

    await this.secretStorage.store(SECRET_KEY, normalized);
    return true;
  }

  async clearApiKey() {
    await this.secretStorage.delete(SECRET_KEY);
  }

  getConfiguredModel() {
    return vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .get("openRouter.model", "mock/echo");
  }

  getConfiguredBaseUrl() {
    // The plugin talks to the Proxy Service; expose its URL for display/settings.
    return this.getBackendHttpUrl();
  }

  getBackendHttpUrl() {
    return vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .get("backend.httpUrl", "http://localhost:8000");
  }

  getBackendWsUrl() {
    return vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .get("backend.wsUrl", "ws://localhost:8090");
  }

  async listModels() {
    if (typeof fetch !== "function") {
      throw new Error("Глобальный fetch недоступен в extension host.");
    }

    const token = await this.getApiKey();
    const httpUrl = this.getBackendHttpUrl().replace(/\/+$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const headers = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`${httpUrl}/v1/models`, {
        method: "GET",
        signal: controller.signal,
        headers,
      });

      const raw = await response.text();
      const payload = raw ? tryParseJson(raw) : undefined;

      if (!response.ok) {
        this.logRaw("models list error", response.status, raw);
        const detail = payload?.detail || (typeof raw === "string" ? raw : "");
        throw new Error(
          `Не удалось получить список моделей: HTTP ${response.status}${
            detail ? `: ${detail}` : ""
          }`
        );
      }

      return Array.isArray(payload?.models) ? payload.models : [];
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Запрос списка моделей превысил timeout 15с.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async saveConnectionSettings({ apiKey, model, baseUrl, clearApiKey }) {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    const normalizedModel = String(model || "").trim();
    const normalizedBaseUrl = String(baseUrl || "").trim();

    if (!normalizedModel) {
      throw new Error("Модель не должна быть пустой.");
    }

    if (!normalizedBaseUrl) {
      throw new Error("Endpoint не должен быть пустым.");
    }

    await vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .update("openRouter.model", normalizedModel, target);

    await vscode.workspace
      .getConfiguration("aiAgentAssistant")
      .update("backend.httpUrl", normalizedBaseUrl, target);

    if (clearApiKey) {
      await this.clearApiKey();
    }

    if (String(apiKey || "").trim()) {
      await this.storeApiKey(apiKey);
    }

    return {
      model: normalizedModel,
      baseUrl: normalizedBaseUrl,
      hasStoredApiKey: await this.hasStoredApiKey(),
    };
  }

  logRaw(label, status, raw) {
    if (!this.outputChannel) {
      return;
    }
    this.outputChannel.appendLine(
      `[OpenRouterClient] ${label} (HTTP ${status})`
    );
    if (typeof raw === "string" && raw.length > 0) {
      const snippet = raw.length > 4000 ? `${raw.slice(0, 4000)}\n…[truncated]` : raw;
      this.outputChannel.appendLine(snippet);
    }
  }

  async createChatCompletion({ messages, tools }) {
    const token = await this.getApiKey();
    if (typeof fetch !== "function") {
      throw new Error("Глобальный fetch недоступен в extension host.");
    }
    if (!token) {
      throw new Error(
        "Не найден access token. Откройте настройки ассистента и сохраните токен доступа."
      );
    }

    const config = vscode.workspace.getConfiguration("aiAgentAssistant");
    const model = this.getConfiguredModel();
    const httpUrl = this.getBackendHttpUrl().replace(/\/+$/, "");
    const wsUrl = this.getBackendWsUrl().replace(/\/+$/, "");
    const timeoutMs = Number(config.get("openRouter.requestTimeoutMs", 120000));
    const responseTimeoutMs = Number(config.get("backend.responseTimeoutMs", 600000));

    const requestBody = {
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.1,
      stream: false,
    };

    const requestStartedAt = Date.now();
    this.logger.append("llm_request", {
      baseUrl: httpUrl,
      model,
      messageCount: messages.length,
      toolCount: tools?.length || 0,
      messages,
      tools,
    });

    try {
      // 1) Proxy Service: enqueue the request and receive a requestId.
      const requestId = await this.submitRequest(httpUrl, token, requestBody, timeoutMs);
      this.logger.append("request_submitted", { requestId, httpUrl, model });

      // 2) Request Service: open a WebSocket keyed by requestId, await the completion.
      // Uses a separate, generous timeout — local models on CPU can take minutes.
      const payload = await this.awaitResponse(wsUrl, requestId, token, responseTimeoutMs);
      if (!payload) {
        throw new Error("Request Service вернул пустой ответ.");
      }

      this.logger.append("llm_response", {
        ok: true,
        ms: Date.now() - requestStartedAt,
        model,
        requestId,
        usage: payload?.usage || null,
        choiceCount: payload?.choices?.length || 0,
        response: payload,
      });
      return payload;
    } catch (error) {
      this.logger.append("llm_response", {
        ok: false,
        ms: Date.now() - requestStartedAt,
        model,
        error: error?.message || String(error),
      });
      throw error;
    }
  }

  async submitRequest(httpUrl, token, requestBody, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${httpUrl}/v1/requests`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
      });

      const raw = await response.text();
      const payload = raw ? tryParseJson(raw) : undefined;

      if (!response.ok) {
        this.logRaw("proxy error response", response.status, raw);
        const detail = payload?.detail || (typeof raw === "string" ? raw : "");
        throw new Error(
          `Proxy Service вернул HTTP ${response.status}${
            response.statusText ? ` ${response.statusText}` : ""
          }${detail ? `: ${detail}` : ""}`
        );
      }

      const requestId = payload?.requestId || payload?.request_id;
      if (!requestId) {
        throw new Error("Proxy Service не вернул requestId.");
      }
      return requestId;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Запрос к Proxy Service превысил timeout ${timeoutMs} мс.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  awaitResponse(wsUrl, requestId, token, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = `${wsUrl}/ws/${encodeURIComponent(requestId)}?token=${encodeURIComponent(
        token
      )}`;

      let settled = false;
      const ws = new WebSocket(url);

      const finish = (fn, arg) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch (_error) {
          // ignore close errors
        }
        fn(arg);
      };

      const timer = setTimeout(() => {
        finish(
          reject,
          new Error(
            `Ожидание ответа от Request Service превысило timeout ${timeoutMs} мс.`
          )
        );
      }, timeoutMs);

      ws.on("message", (data) => {
        let parsed;
        try {
          parsed = JSON.parse(data.toString());
        } catch (_error) {
          finish(reject, new Error("Request Service прислал некорректный JSON."));
          return;
        }

        if (parsed?.type === "error") {
          finish(reject, new Error(parsed.error || "Request Service вернул ошибку."));
          return;
        }

        finish(resolve, parsed?.payload);
      });

      ws.on("error", (error) => {
        finish(
          reject,
          new Error(
            `Ошибка WebSocket соединения с Request Service: ${error?.message || error}`
          )
        );
      });

      ws.on("close", () => {
        finish(reject, new Error("Request Service закрыл соединение без ответа."));
      });
    });
  }
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return undefined;
  }
}

function isOpenRouterBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname === "openrouter.ai";
  } catch (_error) {
    return String(baseUrl || "").includes("openrouter.ai");
  }
}

function buildErrorMessage({ status, statusText, payload, raw, model, baseUrl }) {
  const error = payload?.error || payload?.choices?.[0]?.error || {};
  const head =
    error.message ||
    payload?.message ||
    (typeof raw === "string" && raw.length < 200 ? raw : "") ||
    `LLM endpoint returned HTTP ${status}${statusText ? ` ${statusText}` : ""}`;

  const parts = [head];
  const detailParts = [];
  if (status) {
    detailParts.push(`HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
  }
  if (error.code) {
    detailParts.push(`code=${error.code}`);
  }
  if (error.type) {
    detailParts.push(`type=${error.type}`);
  }
  if (model) {
    detailParts.push(`model=${model}`);
  }

  const meta = error.metadata || {};
  const metaParts = [];
  if (meta.provider_name || meta.provider) {
    metaParts.push(`provider=${meta.provider_name || meta.provider}`);
  }
  if (meta.reason) {
    metaParts.push(`reason=${meta.reason}`);
  }
  if (typeof meta.raw === "string" && meta.raw.trim()) {
    const trimmed = meta.raw.trim();
    metaParts.push(
      `raw=${trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed}`
    );
  } else if (meta.raw && typeof meta.raw === "object") {
    const stringified = safeStringify(meta.raw);
    metaParts.push(
      `raw=${stringified.length > 240 ? `${stringified.slice(0, 240)}…` : stringified}`
    );
  }

  if (detailParts.length) {
    parts.push(`(${detailParts.join(", ")})`);
  }
  if (metaParts.length) {
    parts.push(metaParts.join(" • "));
  }

  if (!error.message && !payload?.message && raw && raw.length >= 200) {
    parts.push(
      `Полный ответ виден в Output → AI Agent Assistant. Endpoint: ${baseUrl}`
    );
  }

  return parts.join(" ");
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

module.exports = {
  OpenRouterClient,
  buildErrorMessage,
};
