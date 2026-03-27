import {
  Codex,
  Thread,
  type ThreadEvent,
  type ThreadOptions,
  type CodexOptions,
  type Input,
} from "@openai/codex-sdk";
import { IStorage } from "../storage/interface";
import {
  DEFAULT_CODEX_MODELS,
  ModelInfo,
  PermissionMode,
  setCodexModels,
  resolveModelForProvider,
  TargetTool,
} from "../models/types";
import { StreamManager } from "../utils/stream-manager";
import {
  AgentAssistantMessage,
  AgentMessage,
  AgentResultMessage,
  AgentUserMessage,
} from "../models/agent-message";
import { AgentCallbacks, AgentToolInfo, IAgentManager } from "./agent-manager";

interface QueuedInput {
  input: Input;
}

export class CodexManager implements IAgentManager {
  readonly provider = "codex" as const;
  private storage: IStorage;
  private streamManager = new StreamManager<QueuedInput>();
  private onAgentResponse: (
    userId: string,
    message: AgentMessage | null,
    toolInfo?: AgentToolInfo,
    parentToolUseId?: string,
  ) => Promise<void>;
  private onAgentError: (userId: string, error: string) => void;
  private codex: Codex;
  private threads = new Map<number, Thread>();
  private dynamicModelCache: ModelInfo[] | null = null;
  private dynamicModelCacheAt = 0;
  private dynamicModelFetchInFlight: Promise<void> | null = null;

  constructor(
    storage: IStorage,
    callbacks: AgentCallbacks,
    options?: CodexOptions,
  ) {
    this.storage = storage;
    this.onAgentResponse = callbacks.onAgentResponse;
    this.onAgentError = callbacks.onAgentError;
    this.codex = new Codex(options);
    this.primeModelCache();
  }

  async addMessageToStream(chatId: number, prompt: string): Promise<void> {
    const session = await this.storage.getUserSession(chatId);
    if (!session) {
      console.error(`[CodexManager] No session found for chatId: ${chatId}`);
      return;
    }

    if (!this.streamManager.isStreamActive(chatId)) {
      await this.startNewQuery(chatId);
    }

    this.streamManager.addMessage(chatId, { input: prompt });
  }

  async addImageMessageToStream(
    chatId: number,
    _base64Data: string,
    _mediaType: string,
    _caption?: string,
  ): Promise<void> {
    this.onAgentError(
      chatId.toString(),
      "Image input is not supported yet in Codex mode.",
    );
  }

  async abortQuery(chatId: number): Promise<boolean> {
    this.threads.delete(chatId);
    return this.streamManager.abortStream(chatId);
  }

  isQueryRunning(chatId: number): boolean {
    return this.streamManager.isStreamActive(chatId);
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (
      this.dynamicModelCache &&
      now - this.dynamicModelCacheAt < 5 * 60 * 1000
    ) {
      return this.dynamicModelCache;
    }

    if (this.dynamicModelCache) {
      // Return stale cache immediately and refresh in background.
      this.primeModelCache();
      return this.dynamicModelCache;
    }

    // No cache yet: return defaults immediately and warm in background.
    this.primeModelCache();
    return DEFAULT_CODEX_MODELS;
  }

  async shutdown(): Promise<void> {
    this.streamManager.shutdown();
    this.threads.clear();
    await this.storage.disconnect();
  }

  private async startNewQuery(chatId: number): Promise<void> {
    const stream = this.streamManager.getOrCreateStream(chatId);
    const controller = this.streamManager.getController(chatId)!;

    this.processQueue(chatId, stream, controller).catch((error) => {
      const message =
        error instanceof Error ? error.message : "Unknown Codex error";
      this.onAgentError(chatId.toString(), message);
    });
  }

  private async processQueue(
    chatId: number,
    stream: AsyncIterable<QueuedInput>,
    controller: AbortController,
  ): Promise<void> {
    const userSession = await this.storage.getUserSession(chatId);
    if (!userSession) {
      return;
    }

    try {
      for await (const queued of stream) {
        if (controller.signal.aborted) {
          break;
        }

        const thread = this.getOrCreateThread(chatId, userSession);
        const { events } = await thread.runStreamed(queued.input, {
          signal: controller.signal,
        });

        const start = Date.now();
        for await (const event of events) {
          await this.handleThreadEvent(chatId, event, userSession);
        }

        const resultMessage: AgentResultMessage = {
          type: "result",
          subtype: "success",
          duration_ms: Date.now() - start,
        };
        await this.onAgentResponse(chatId.toString(), resultMessage);
        await this.storage.updateSessionActivity(userSession);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      throw error;
    } finally {
      await this.onAgentResponse(chatId.toString(), null, undefined, undefined);
      this.streamManager.abortStream(chatId);
      this.threads.delete(chatId);
    }
  }

  private getOrCreateThread(chatId: number, session: any): Thread {
    const existing = this.threads.get(chatId);
    if (existing) {
      return existing;
    }

    const threadOptions: ThreadOptions = {
      model: resolveModelForProvider("codex", session.currentModel),
      workingDirectory: session.projectPath,
      skipGitRepoCheck: true,
      sandboxMode: this.mapSandboxMode(session.permissionMode),
      approvalPolicy: this.mapApprovalMode(session.permissionMode),
      webSearchEnabled: true,
      networkAccessEnabled: true,
    };

    const thread = session.sessionId
      ? this.codex.resumeThread(session.sessionId, threadOptions)
      : this.codex.startThread(threadOptions);

    this.threads.set(chatId, thread);
    return thread;
  }

  private mapSandboxMode(
    mode: PermissionMode,
  ): "read-only" | "workspace-write" {
    return mode === PermissionMode.Plan ? "read-only" : "workspace-write";
  }

  private mapApprovalMode(_mode: PermissionMode): "never" {
    // Telegram permission flow is handled externally; avoid blocking TTY prompts in Codex CLI.
    return "never";
  }

  private async handleThreadEvent(
    chatId: number,
    event: ThreadEvent,
    session: any,
  ): Promise<void> {
    if (
      event.type === "thread.started" &&
      session.sessionId !== event.thread_id
    ) {
      session.sessionId = event.thread_id;
      await this.storage.saveUserSession(session);
      return;
    }

    if (
      event.type === "item.started" ||
      event.type === "item.updated" ||
      event.type === "item.completed"
    ) {
      const { message, toolInfo, parentToolUseId } = this.mapItemEvent(event);
      if (message) {
        await this.onAgentResponse(
          chatId.toString(),
          message,
          toolInfo,
          parentToolUseId,
        );
      }
      return;
    }

    if (event.type === "turn.failed" || event.type === "error") {
      const errorMessage =
        event.type === "turn.failed" ? event.error.message : event.message;
      this.onAgentError(chatId.toString(), errorMessage);
    }
  }

  private mapItemEvent(
    event: Extract<
      ThreadEvent,
      { type: "item.started" | "item.updated" | "item.completed" }
    >,
  ): {
    message?: AgentMessage;
    toolInfo?: AgentToolInfo;
    parentToolUseId?: string;
  } {
    const item = event.item;

    if (item.type === "agent_message") {
      const message: AgentAssistantMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: item.text }],
        },
      };
      return { message };
    }

    if (item.type === "reasoning") {
      const message: AgentAssistantMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: item.text }],
        },
      };
      return { message };
    }

    if (item.type === "command_execution") {
      if (item.status === "in_progress") {
        const message: AgentAssistantMessage = {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: TargetTool.Bash,
                input: { command: item.command },
              },
            ],
          },
        };
        return {
          message,
          toolInfo: {
            toolId: item.id,
            toolName: TargetTool.Bash,
            isToolUse: true,
            isToolResult: false,
          },
        };
      }

      if (event.type === "item.completed") {
        const message: AgentUserMessage = {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: item.id,
                content: item.aggregated_output,
                is_error:
                  item.status === "failed" || (item.exit_code ?? 0) !== 0,
              },
            ],
          },
        };
        return {
          message,
          toolInfo: {
            toolId: item.id,
            toolName: TargetTool.Bash,
            isToolUse: false,
            isToolResult: true,
          },
        };
      }
    }

    if (item.type === "mcp_tool_call") {
      const mappedToolName = this.mapToolName(item.tool);

      if (item.status === "in_progress" && mappedToolName) {
        const message: AgentAssistantMessage = {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: item.id,
                name: mappedToolName,
                input: this.ensureRecord(item.arguments),
              },
            ],
          },
        };
        return {
          message,
          toolInfo: {
            toolId: item.id,
            toolName: mappedToolName,
            isToolUse: true,
            isToolResult: false,
          },
        };
      }

      if (event.type === "item.completed") {
        const content = item.result
          ? JSON.stringify(item.result)
          : item.error?.message || "";
        const message: AgentUserMessage = {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: item.id,
                content,
                is_error: item.status === "failed",
              },
            ],
          },
        };

        if (!mappedToolName) {
          return { message };
        }

        return {
          message,
          toolInfo: {
            toolId: item.id,
            toolName: mappedToolName,
            isToolUse: false,
            isToolResult: true,
          },
        };
      }
    }

    if (item.type === "error") {
      const message: AgentAssistantMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Error: ${item.message}` }],
        },
      };
      return { message };
    }

    return {};
  }

  private mapToolName(toolName: string): TargetTool | undefined {
    const normalized = toolName.toLowerCase();

    if (normalized.includes("task")) return TargetTool.Task;
    if (
      normalized.includes("bash") ||
      normalized.includes("shell") ||
      normalized.includes("command")
    )
      return TargetTool.Bash;
    if (normalized.includes("glob")) return TargetTool.Glob;
    if (normalized.includes("grep")) return TargetTool.Grep;
    if (normalized === "ls" || normalized.includes("list"))
      return TargetTool.LS;
    if (normalized.includes("read")) return TargetTool.Read;
    if (normalized.includes("multiedit")) return TargetTool.MultiEdit;
    if (normalized.includes("edit")) return TargetTool.Edit;
    if (normalized.includes("write")) return TargetTool.Write;
    if (normalized.includes("todo")) return TargetTool.TodoWrite;
    if (normalized.includes("exitplanmode")) return TargetTool.ExitPlanMode;

    return undefined;
  }

  private ensureRecord(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return {};
    }
    return input as Record<string, unknown>;
  }

  private primeModelCache(): void {
    if (this.dynamicModelFetchInFlight) {
      return;
    }

    this.dynamicModelFetchInFlight = this.fetchCodexModelsFromAgent()
      .then((models) => {
        if (models.length > 0) {
          this.dynamicModelCache = models;
          this.dynamicModelCacheAt = Date.now();
          setCodexModels(models);
        }
      })
      .catch((error) => {
        console.warn(
          "[CodexManager] Failed to prime model cache:",
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        this.dynamicModelFetchInFlight = null;
      });
  }

  private async fetchCodexModelsFromAgent(): Promise<ModelInfo[]> {
    // Keep dynamic pipeline in place, but hardcode currently supported Codex models for stability.
    return DEFAULT_CODEX_MODELS.map((model) => ({ ...model }));
  }

}
