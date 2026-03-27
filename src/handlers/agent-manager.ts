import { AgentMessage } from '../models/agent-message';
import { AgentProvider, ModelInfo } from '../models/types';

export interface AgentToolInfo {
  toolId: string;
  toolName: string;
  isToolUse: boolean;
  isToolResult: boolean;
}

export interface AgentCallbacks {
  onAgentResponse: (userId: string, message: AgentMessage | null, toolInfo?: AgentToolInfo, parentToolUseId?: string) => Promise<void>;
  onAgentError: (userId: string, error: string) => void;
}

export interface IAgentManager {
  readonly provider: AgentProvider;
  addMessageToStream(chatId: number, prompt: string): Promise<void>;
  addImageMessageToStream(chatId: number, base64Data: string, mediaType: string, caption?: string): Promise<void>;
  abortQuery(chatId: number): Promise<boolean>;
  isQueryRunning(chatId: number): boolean;
  getAvailableModels(): Promise<ModelInfo[]>;
  setProvider?(provider: AgentProvider): Promise<void> | void;
  shutdown(): Promise<void>;
}
