const { RequestClassifier } = require("./RequestClassifier");
const { sanitizeAssistantText } = require("../util/DisplaySanitizer");
const { NullLogger } = require("../util/Logger");

// A plain code-block answer (no tool call) may be applied as a file edit for any
// request EXCEPT a pure explanation/question — covers weak models that can't reliably
// emit tool calls, while not clobbering files when the user only asked a question.
const NON_EDIT_INTENTS = new Set(["explain", "question"]);

class AgentRuntime {
  constructor({ contextCollector, openRouterClient, toolExecutor, outputChannel, logger }) {
    this.contextCollector = contextCollector;
    this.openRouterClient = openRouterClient;
    this.toolExecutor = toolExecutor;
    this.outputChannel = outputChannel;
    this.logger = logger || new NullLogger();
    this.classifier = new RequestClassifier();
  }

  async previewContext() {
    return this.contextCollector.previewContext();
  }

  async applyPendingChanges() {
    return this.toolExecutor.applyPendingChanges();
  }

  async rejectPendingChanges() {
    return this.toolExecutor.rejectPendingChanges();
  }

  buildFileChangeFromText(text) {
    if (!this.toolExecutor.hasActiveEditor()) {
      return null;
    }
    const code = extractFencedCode(text);
    if (!code) {
      return null;
    }
    return {
      id: `fallback-replace-${Date.now()}`,
      type: "function",
      function: {
        name: "replace_active_file",
        arguments: JSON.stringify({ content: code }),
      },
    };
  }

  async runTurn({
    prompt,
    history,
    iterationLimit,
    continuationState,
    onStatus,
    onToolEvent,
  }) {
    let contextPreview = continuationState?.contextPreview || "";
    let messages;
    let classification = null;

    if (continuationState?.messages?.length) {
      messages = cloneMessages(continuationState.messages);
      onStatus?.("Продолжаю агентную сессию с сохраненного шага...");
      this.logger.append("turn_continued", {
        iterationLimit: iterationLimit,
        messageCount: messages.length,
      });
    } else {
      onStatus?.("Собираю файл, импорты и тесты...");
      classification = this.classifier.classify(prompt);
      this.logger.append("request_classified", {
        prompt: String(prompt || ""),
        type: classification.type,
        confidence: classification.confidence,
        signals: classification.signals,
        scores: classification.scores,
        promptLength: classification.promptLength,
      });
      const context = await this.contextCollector.collectContext(prompt);
      messages = this.buildMessages(history, context.promptText);
      contextPreview = context.summaryText;
      this.logger.append("turn_started", {
        requestType: classification.type,
        contextSummary: context.summaryText,
        activeFile: context.activeFile?.path || null,
        imports: context.imports?.length || 0,
        relatedTests: context.tests?.length || 0,
        historyLength: history?.length || 0,
      });
    }

    const tools = this.toolExecutor.getToolDefinitions();
    const maxIterations = normalizeIterationLimit(iterationLimit);
    const allowCodeBlockApply =
      Boolean(classification) && !NON_EDIT_INTENTS.has(classification.type);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      onStatus?.(
        iteration === 0
          ? "Отправляю контекст в LLM endpoint..."
          : `Продолжаю agent loop (${iteration + 1}/${maxIterations})...`
      );

      const response = await this.openRouterClient.createChatCompletion({
        messages,
        tools,
      });
      const choice = response?.choices?.[0];

      if (!choice?.message) {
        throw new Error("LLM endpoint вернул ответ без choices[0].message.");
      }

      const assistantMessage = normalizeAssistantMessage(choice.message);
      let toolCalls = assistantMessage.tool_calls || [];

      // Fallback for models that return code as a fenced block instead of calling a
      // tool (e.g. small local models): turn it into a replace_active_file edit so it
      // still goes through the diff/approval flow. Edit-intent requests only.
      if (toolCalls.length === 0 && allowCodeBlockApply) {
        const fallbackCall = this.buildFileChangeFromText(
          extractText(assistantMessage.content)
        );
        if (fallbackCall) {
          toolCalls = [fallbackCall];
          assistantMessage.tool_calls = toolCalls;
          assistantMessage.content = "";
          onToolEvent?.({
            summary:
              "Модель вернула код без вызова инструмента — оформляю как замену активного файла.",
          });
        }
      }

      messages.push(assistantMessage);

      this.logger.append("assistant_message", {
        iteration,
        rawContent: extractText(assistantMessage.content),
        toolCallCount: toolCalls.length,
        toolCallNames: toolCalls.map((c) => c?.function?.name).filter(Boolean),
        usage: response?.usage || null,
      });

      if (toolCalls.length === 0) {
        const rawFinal = extractText(assistantMessage.content);
        const displayFinal = sanitizeAssistantText(rawFinal) || "Готово. Изменения применены.";
        this.logger.append("turn_completed", {
          iterations: iteration + 1,
          displayLength: displayFinal.length,
        });
        return {
          status: "completed",
          assistantMessage: displayFinal,
          contextPreview,
        };
      }

      const rawAssistantText = extractText(assistantMessage.content);
      const displayAssistantText = sanitizeAssistantText(rawAssistantText);
      if (displayAssistantText) {
        onToolEvent?.({
          summary: `Промежуточный ответ агента: ${displayAssistantText}`,
        });
      }

      let approvalRequested = false;
      for (let index = 0; index < toolCalls.length; index += 1) {
        const toolCall = toolCalls[index];
        onStatus?.(`Выполняю инструмент ${toolCall.function?.name}...`);
        const result = await this.toolExecutor.executeToolCall(toolCall, {
          onEvent: (event) => {
            onToolEvent?.(event);
          },
        });
        messages.push(result.toolMessage);
        onToolEvent?.({
          summary: result.summary,
          displayMessage: result.displayMessage,
        });

        if (result.requiresApproval) {
          approvalRequested = true;
          const nextToolName = toolCalls[index + 1]?.function?.name;
          if (!nextToolName || !this.toolExecutor.isDeferredFileChangeTool(nextToolName)) {
            break;
          }
        }
      }

      if (approvalRequested) {
        return {
          status: "needsApproval",
          contextPreview,
          approvalMessage: this.toolExecutor.getPendingApprovalSummary(),
          approvalState: {
            messages: cloneMessages(messages),
            contextPreview,
          },
        };
      }
    }

    return {
      status: "needsContinuation",
      contextPreview,
      continuationMessage: `Достигнут лимит ${maxIterations} итераций. Можно продолжить без потери прогресса.`,
      continuationState: {
        messages: cloneMessages(messages),
        contextPreview,
      },
    };
  }

  buildMessages(history, currentPrompt) {
    const preservedHistory = history.slice(-12).map((item) => ({
      role: item.role,
      content: item.content,
    }));

    return [
      {
        role: "system",
        content: [
          "You are a VS Code coding assistant with project tools.",
          "Work in the user's language when reasonable.",
          "You receive an up-to-date context snapshot on every turn.",
          "Use tools to read files, modify files, search the workspace, and run commands.",
          "Prefer actual tool execution over describing intended edits.",
          "When editing files, write the complete final content.",
          "File changes may be staged for user approval before they are applied.",
          "Do not assume staged changes are already applied until a later system message confirms approval.",
          "Avoid destructive or risky actions unless they are clearly necessary.",
          "After applying a change you may receive a system or tool message starting with '[Memory of past similar changes]'.",
          "Treat that block as predicted failures from similar past diffs: read the stack traces, decide whether the current change has the same risk, and proactively patch the issue before running real tests.",
          "After tool usage, provide a concise final answer summarizing what changed and any next verification step.",
        ].join(" "),
      },
      ...preservedHistory,
      {
        role: "user",
        content: currentPrompt,
      },
    ];
  }
}

function normalizeIterationLimit(value) {
  return Math.max(1, Math.min(100, Number(value) || 1));
}

function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages || []));
}

function normalizeAssistantMessage(message) {
  return {
    role: "assistant",
    content: message.content ?? "",
    tool_calls: message.tool_calls || message.toolCalls || [],
  };
}

function extractText(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item?.text === "string") {
          return item.text;
        }
        if (typeof item?.content === "string") {
          return item.content;
        }
        return "";
      })
      .join("")
      .trim();
  }

  return "";
}

function extractFencedCode(text) {
  if (typeof text !== "string" || !text.includes("```")) {
    return null;
  }
  // Pick the largest fenced block — for a refactor that's the full file content.
  const re = /```[a-zA-Z0-9_+#.-]*[ \t]*\r?\n?([\s\S]*?)```/g;
  let match;
  let best = "";
  while ((match = re.exec(text)) !== null) {
    const body = (match[1] || "").trim();
    if (body.length > best.length) {
      best = body;
    }
  }
  return best.length > 0 ? best : null;
}

module.exports = {
  AgentRuntime,
};
