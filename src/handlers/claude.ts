import { query, type Options, AbortError, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { IStorage } from '../storage/interface';
import { getModelsForProvider, ModelInfo, resolveModelForProvider, TargetTool } from '../models/types';
import { PermissionManager } from './permission-manager';
import { StreamManager } from '../utils/stream-manager';
import { AgentMessage, AgentUserMessage } from '../models/agent-message';
import { AgentCallbacks, AgentToolInfo, IAgentManager } from './agent-manager';

export class ClaudeManager implements IAgentManager {
  readonly provider = 'claude' as const;
  private storage: IStorage;
  private permissionManager: PermissionManager;
  private streamManager = new StreamManager<AgentUserMessage>();
  private binaryPath: string | undefined;
  private onAgentResponse: (userId: string, message: AgentMessage | null, toolInfo?: AgentToolInfo, parentToolUseId?: string) => Promise<void>;
  private onAgentError: (userId: string, error: string) => void;

  constructor(
    storage: IStorage,
    permissionManager: PermissionManager,
    callbacks: AgentCallbacks,
    binaryPath?: string
  ) {
    this.storage = storage;
    this.permissionManager = permissionManager;
    this.onAgentResponse = callbacks.onAgentResponse;
    this.onAgentError = callbacks.onAgentError;
    this.binaryPath = binaryPath;
  }

  async addMessageToStream(chatId: number, prompt: string): Promise<void> {
    const session = await this.storage.getUserSession(chatId);
    if (!session) {
      console.error(`[ClaudeManager] No session found for chatId: ${chatId}`);
      return;
    }

    const userMessage: AgentUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt
          }
        ]
      },
      parent_tool_use_id: null,
      session_id: ''
    };

    // If no active query, start a new one
    if (!this.streamManager.isStreamActive(chatId)) {
      await this.startNewQuery(chatId, session);
    }

    // Add message to existing stream
    this.streamManager.addMessage(chatId, userMessage);
  }

  async addImageMessageToStream(chatId: number, base64Data: string, mediaType: string, caption?: string): Promise<void> {
    const session = await this.storage.getUserSession(chatId);
    if (!session) {
      console.error(`[ClaudeManager] No session found for chatId: ${chatId}`);
      return;
    }

    const content: Array<Record<string, unknown>> = [];
    if (caption) {
      content.push({ type: 'text', text: caption });
    }
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64Data
      }
    });

    const userMessage: AgentUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: content as any
      },
      parent_tool_use_id: null,
      session_id: ''
    };

    if (!this.streamManager.isStreamActive(chatId)) {
      await this.startNewQuery(chatId, session);
    }

    this.streamManager.addMessage(chatId, userMessage);
  }

  async sendMessage(chatId: number, prompt: AsyncIterable<AgentUserMessage>, options: Options): Promise<void> {
    const userSession = await this.storage.getUserSession(chatId);
    if (!userSession) {
      throw new Error('User session not found');
    }

    try {
      for await (const message of query({
        prompt: prompt as AsyncIterable<SDKUserMessage>,
        options: options
      })) {
        if (message.session_id && userSession.sessionId !== message.session_id) {
          userSession.sessionId = message.session_id;
          await this.storage.saveUserSession(userSession);
        }
        console.debug(JSON.stringify(message, null, 2));

        // Detect tool use and tool result in message content
        const toolInfo = this.extractToolInfo(message as AgentMessage);
        const parentToolUseId = (message as any).parent_tool_use_id || undefined;

        await this.onAgentResponse(chatId.toString(), message as AgentMessage, toolInfo, parentToolUseId);
      }
    } catch (error) {
      // Don't throw error if it's caused by abort
      if (error instanceof AbortError) {
        return;
      }

      this.onAgentError?.(chatId.toString(), error instanceof Error ? error.message : 'Unknown error');
      throw error;
    } finally {
      // Signal completion with null message to indicate completion
      this.onAgentResponse(chatId.toString(), null, undefined, undefined);
    }

    await this.storage.updateSessionActivity(userSession);
  }

  async abortQuery(chatId: number): Promise<boolean> {
    return this.streamManager.abortStream(chatId);
  }

  isQueryRunning(chatId: number): boolean {
    return this.streamManager.isStreamActive(chatId);
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return getModelsForProvider(this.provider);
  }

  async shutdown(): Promise<void> {
    this.streamManager.shutdown();
    await this.storage.disconnect();
  }

  private extractToolInfo(message: AgentMessage): AgentToolInfo | undefined {
    const targetTools = Object.values(TargetTool);
    const messageWithContent = message as any;

    // Check if message has content array
    if (!messageWithContent.message?.content || !Array.isArray(messageWithContent.message.content)) {
      return undefined;
    }

    // Check for tool_use in assistant messages
    if (messageWithContent.type === 'assistant') {
      for (const block of messageWithContent.message.content as any[]) {
        if (block.type === 'tool_use' && targetTools.includes(block.name)) {
          return {
            toolId: block.id,
            toolName: block.name,
            isToolUse: true,
            isToolResult: false
          };
        }
      }
    }

    // Check for tool_result in user messages
    if (messageWithContent.type === 'user') {
      for (const block of messageWithContent.message.content as any[]) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          return {
            toolId: block.tool_use_id,
            toolName: '', // We'll retrieve this from Redis
            isToolUse: false,
            isToolResult: true
          };
        }
      }
    }

    return undefined;
  }

  private async startNewQuery(chatId: number, session: any): Promise<void> {
    const stream = this.streamManager.getOrCreateStream(chatId);
    const controller = this.streamManager.getController(chatId)!;
    
    const options: Options = {
      cwd: session.projectPath,
      model: resolveModelForProvider('claude', session.currentModel),
      ...(session.sessionId ? { resume: session.sessionId } : {}),
      ...(this.binaryPath ? { pathToClaudeCodeExecutable: this.binaryPath } : {}),
      abortController: controller,
      permissionMode: session.permissionMode,
      // New SDK requires explicit system prompt and settings configuration
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        try {
          // Inject chatId into input for PermissionManager use
          const inputWithChatId = { ...input, __chatId: chatId };
          const result = await this.permissionManager.canUseTool(toolName, inputWithChatId);
          return result;
        } catch (error) {
          return {
            behavior: 'deny',
            message: `Permission check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          };
        }
      },
    };

    // Start query
    this.sendMessage(chatId, stream, options);
  }

}
