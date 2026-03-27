import { AgentProvider, ModelInfo } from '../models/types';
import { IAgentManager } from './agent-manager';

export class ProviderRouterManager implements IAgentManager {
  private currentProvider: AgentProvider;
  private managers: Record<AgentProvider, IAgentManager>;

  constructor(initialProvider: AgentProvider, managers: Record<AgentProvider, IAgentManager>) {
    this.currentProvider = initialProvider;
    this.managers = managers;
  }

  get provider(): AgentProvider {
    return this.currentProvider;
  }

  setProvider(provider: AgentProvider): void {
    this.currentProvider = provider;
  }

  private get activeManager(): IAgentManager {
    return this.managers[this.currentProvider];
  }

  async addMessageToStream(chatId: number, prompt: string): Promise<void> {
    await this.activeManager.addMessageToStream(chatId, prompt);
  }

  async addImageMessageToStream(chatId: number, base64Data: string, mediaType: string, caption?: string): Promise<void> {
    await this.activeManager.addImageMessageToStream(chatId, base64Data, mediaType, caption);
  }

  async abortQuery(chatId: number): Promise<boolean> {
    return this.activeManager.abortQuery(chatId);
  }

  isQueryRunning(chatId: number): boolean {
    return this.activeManager.isQueryRunning(chatId);
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return this.activeManager.getAvailableModels();
  }

  async shutdown(): Promise<void> {
    await this.activeManager.shutdown();
  }
}
