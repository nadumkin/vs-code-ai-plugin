const vscode = require("vscode");
const { AssistantViewProvider } = require("./ui/AssistantViewProvider");
const { ContextCollector } = require("./agent/ContextCollector");
const { OpenRouterClient } = require("./agent/OpenRouterClient");
const { ToolExecutor } = require("./agent/ToolExecutor");
const { AgentRuntime } = require("./agent/AgentRuntime");
const { MemoryManager } = require("./memory/MemoryManager");
const { Logger } = require("./util/Logger");

let activeLogger = null;

function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("AI Agent Assistant");
  const logger = new Logger({ context, outputChannel });
  activeLogger = logger;
  logger.append("session_start", {
    version: context.extension?.packageJSON?.version || "unknown",
    workspace: vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || null,
    vscodeVersion: vscode.version,
  });

  const contextCollector = new ContextCollector(outputChannel);
  const openRouterClient = new OpenRouterClient(context.secrets, outputChannel, logger);
  const memoryManager = new MemoryManager(outputChannel);
  const toolExecutor = new ToolExecutor(outputChannel, memoryManager, logger);
  const runtime = new AgentRuntime({
    contextCollector,
    openRouterClient,
    toolExecutor,
    outputChannel,
    logger,
  });
  const viewProvider = new AssistantViewProvider(
    context,
    runtime,
    openRouterClient,
    logger
  );

  context.subscriptions.push(
    outputChannel,
    vscode.window.registerWebviewViewProvider(
      AssistantViewProvider.viewType,
      viewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    ),
    vscode.commands.registerCommand("aiAgentAssistant.focusChat", async () => {
      await viewProvider.focus();
    }),
    vscode.commands.registerCommand("aiAgentAssistant.openSettings", async () => {
      await viewProvider.focus();
      await viewProvider.openSettings();
    }),
    vscode.commands.registerCommand("aiAgentAssistant.clearChat", () => {
      viewProvider.clearChat();
    }),
    vscode.commands.registerCommand("aiAgentAssistant.refreshContext", async () => {
      await viewProvider.refreshContextPreview();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("aiAgentAssistant.agent.maxIterations") ||
        event.affectsConfiguration("aiAgentAssistant.openRouter.model") ||
        event.affectsConfiguration("aiAgentAssistant.openRouter.baseUrl") ||
        event.affectsConfiguration("aiAgentAssistant.execution.autoApplyFileChanges")
      ) {
        viewProvider.reloadConfigurationState();
      }
      if (event.affectsConfiguration("aiAgentAssistant.memory.storagePath")) {
        memoryManager.invalidate();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(async () => {
      await viewProvider.refreshContextPreview();
    }),
    vscode.workspace.onDidSaveTextDocument(async () => {
      await viewProvider.refreshContextPreview();
    })
  );
}

async function deactivate() {
  if (activeLogger) {
    try {
      activeLogger.append("session_end", {});
      await activeLogger.flush();
    } catch (_e) {
      /* ignore */
    }
    activeLogger = null;
  }
}

module.exports = {
  activate,
  deactivate,
};
