import { Context, Telegraf } from 'telegraf';
import { IStorage } from '../../../storage/interface';
import { MessageFormatter } from '../../../utils/formatter';
import { ProjectHandler } from '../project/project-handler';
import { FileBrowserHandler } from '../file-browser/file-browser-handler';
import { UserState, AgentModel, AgentProvider, ModelInfo, getAllProviderModels } from '../../../models/types';
import { PermissionManager } from '../../permission-manager';
import { AgentSessionReader } from '../../../utils/agent-session-reader';
import { KeyboardFactory } from '../keyboards/keyboard-factory';
import { TelegramSender } from '../../../services/telegram-sender';
import { MESSAGES } from '../../../constants/messages';
import { IAgentManager } from '../../agent-manager';
import { Config } from '../../../config/config';

export class CallbackHandler {
  private sessionReader: AgentSessionReader;
  private telegramSender: TelegramSender;

  constructor(
    private formatter: MessageFormatter,
    private projectHandler: ProjectHandler,
    private storage: IStorage,
    private fileBrowserHandler: FileBrowserHandler,
    private bot: Telegraf,
    private permissionManager: PermissionManager,
    private agentManager: IAgentManager,
    private config: Config
  ) {
    this.sessionReader = new AgentSessionReader();
    this.telegramSender = new TelegramSender(bot);
  }

  async handleCallback(ctx: Context): Promise<void> {
    if (!ctx.callbackQuery || !ctx.chat) return;
    if (!('data' in ctx.callbackQuery)) return;

    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat.id;
    const messageId = ctx.callbackQuery?.message?.message_id;

    await ctx.answerCbQuery();

    if (data?.startsWith('onboarding_')) {
      await this.handleOnboardingCallback(ctx, data, chatId, messageId);
    } else if (data === 'project_type_directory') {
      // Use interactive directory picker instead of text input
      const user = await this.storage.getUserSession(chatId);
      if (user) {
        user.setState(UserState.WaitingDirectory);
        await this.storage.saveUserSession(user);
        if (messageId) {
          try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
        }
        await this.fileBrowserHandler.startDirectoryPicker(chatId);
      }
    } else if (data === 'project_type_github') {
      const user = await this.storage.getUserSession(chatId);
      if (user) {
        user.setState(UserState.WaitingRepo);
        await this.storage.saveUserSession(user);
        if (messageId) {
          try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
        }
        await this.bot.telegram.sendMessage(chatId, MESSAGES.GITHUB_PROJECT_TEXT);
      }
    } else if (data?.startsWith('project_type_')) {
      await this.projectHandler.handleProjectTypeSelection(data, chatId);
    } else if (data?.startsWith('project_select_')) {
      await this.handleProjectSelection(data, chatId, messageId);
    } else if (data?.startsWith('project_catalog_')) {
      await this.handleAgentProjectSelection(data, chatId, messageId);
    } else if (data?.startsWith('session_select_')) {
      await this.handleSessionSelection(data, chatId, messageId);
    } else if (data === 'cancel') {
      await this.handleCancelCallback(chatId, messageId);
    } else if (data?.startsWith('approve_') || data?.startsWith('deny_')) {
      await this.handleMCPApprovalCallback(data, chatId, messageId);
    } else if (data?.startsWith('asr_')) {
      await this.handleASRCallback(data, chatId, messageId);
    } else if (data?.startsWith('pick_')) {
      await this.handleDirectoryPickerCallback(data, chatId, messageId);
    } else if (data?.startsWith('file:') || data?.startsWith('directory:') || data?.startsWith('nav:')) {
      await this.fileBrowserHandler.handleFileBrowsingCallback(data, chatId, messageId);
    } else if (data?.startsWith('model_select:')) {
      await this.handleModelSelectCallback(data, chatId, messageId);
    }
  }

  private async handleASRCallback(data: string, chatId: number, messageId?: number): Promise<void> {
    try {
      const user = await this.storage.getUserSession(chatId);
      if (!user) return;

      if (data === 'asr_confirm') {
        const text = await this.storage.getPendingASR(chatId);
        await this.storage.deletePendingASR(chatId);
        if (messageId) {
          try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
        }
        if (text) {
          await this.bot.telegram.sendMessage(chatId, 'Processing...', KeyboardFactory.createCompletionKeyboard());
          await this.agentManager.addMessageToStream(chatId, text);
        }
      } else if (data === 'asr_edit') {
        user.setState(UserState.WaitingASREdit);
        await this.storage.saveUserSession(user);
        if (messageId) {
          try { await this.bot.telegram.editMessageReplyMarkup(chatId, messageId, undefined, { inline_keyboard: [] }); } catch {}
        }
        await this.bot.telegram.sendMessage(chatId, 'Please type or paste your corrected text:');
      } else if (data === 'asr_cancel') {
        await this.storage.deletePendingASR(chatId);
        if (messageId) {
          try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
        }
        await this.bot.telegram.sendMessage(chatId, '❌ Voice message cancelled.');
      }
    } catch (error) {
      console.error('Error handling ASR callback:', error);
    }
  }

  private async handleMCPApprovalCallback(data: string, chatId: number, messageId?: number): Promise<void> {
    try {
      await this.permissionManager.handleApprovalCallback(chatId, data);

      const isApproved = data.startsWith('approve_');
      const message = isApproved ? '✅ Operation approved' : '❌ Operation denied';
      await this.bot.telegram.sendMessage(chatId, message);

      if (messageId) {
        await this.bot.telegram.deleteMessage(chatId, messageId);
      }
    } catch (error) {
      console.error('Error handling approval callback:', error);
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Error handling permission response'), { parse_mode: 'MarkdownV2' });
    }
  }

  private async handleAgentProjectSelection(data: string, chatId: number, messageId?: number): Promise<void> {
    try {
      const shortId = data.replace('project_catalog_', '');
      const user = await this.storage.getUserSession(chatId);

      if (!user) {
        await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('No user session found. Please auth first or /start.'), { parse_mode: 'MarkdownV2' });
        return;
      }

      // Find the full project from agent projects list
      const projects = await this.sessionReader.listAllProjects(50);
      const project = projects.find(p => p.id === shortId || p.id.endsWith(shortId));

      if (!project) {
        await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Project not found.'), { parse_mode: 'MarkdownV2' });
        return;
      }

      // Save project to storage so /status and other commands can find it
      const { createProject } = await import('../../../models/project');
      const storedProject = createProject(
        project.id,
        chatId,
        project.name,
        project.path,
        'local'
      );
      await this.storage.saveProject(storedProject);

      // Set active project using the project path
      user.setActiveProject(project.id, project.path);
      user.setState(UserState.InSession);
      user.setActive(true);
      // Clear previous session ID to start fresh
      delete user.sessionId;
      await this.storage.saveUserSession(user);

      // Delete the project list message
      if (messageId) {
        try {
          await this.bot.telegram.deleteMessage(chatId, messageId);
        } catch (error) {
          console.error('Could not delete message:', error);
        }
      }

      await this.bot.telegram.sendMessage(
        chatId,
        `🚀 Selected project "${project.name}".\n📂 Path: ${project.path}\n\nYou can now chat with the AI coding agent!`
      );
    } catch (error) {
      console.error('Error handling agent project selection:', error);
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Failed to select project. Please try again.'), { parse_mode: 'MarkdownV2' });
    }
  }

  private async handleSessionSelection(data: string, chatId: number, messageId?: number): Promise<void> {
    try {
      const sessionId = data.replace('session_select_', '');
      const user = await this.storage.getUserSession(chatId);

      if (!user) {
        await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('No user session found. Please auth first or /start.'), { parse_mode: 'MarkdownV2' });
        return;
      }

      // Set the AI coding agent session ID to resume
      user.sessionId = sessionId;
      user.setState(UserState.InSession);
      user.setActive(true);
      await this.storage.saveUserSession(user);

      // Delete the session list message
      if (messageId) {
        try {
          await this.bot.telegram.deleteMessage(chatId, messageId);
        } catch (error) {
          console.error('Could not delete message:', error);
        }
      }

      await this.bot.telegram.sendMessage(
        chatId,
        `🔄 Session resumed! You can continue your conversation with the AI coding agent.\n\nSession ID: \`${sessionId.substring(0, 8)}...\``,
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('Error handling session selection:', error);
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Failed to resume session. Please try again.'), { parse_mode: 'MarkdownV2' });
    }
  }

  private async handleProjectSelection(data: string, chatId: number, messageId?: number): Promise<void> {
    try {
      const projectId = data.replace('project_select_', '');
      const user = await this.storage.getUserSession(chatId);
      
      if (!user) {
        await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('No user session found. Please auth first or /start.'), { parse_mode: 'MarkdownV2' });
        return;
      }

      const project = await this.storage.getProject(projectId, chatId);
      if (!project) {
        await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Project not found.'), { parse_mode: 'MarkdownV2' });
        return;
      }

      // Set active project and update session
      user.setActiveProject(projectId, project.localPath);
      user.setState(UserState.InSession);
      user.setActive(true);
      // Clear previous session ID to start fresh
      delete user.sessionId;
      await this.storage.saveUserSession(user);

      // Update project last accessed time
      await this.storage.updateProjectLastAccessed(projectId, chatId);

      // Delete the project list message
      if (messageId) {
        try {
          await this.bot.telegram.deleteMessage(chatId, messageId);
        } catch (error) {
          console.error('Could not delete message:', error);
        }
      }

      await this.bot.telegram.sendMessage(
        chatId, 
        `🚀 Selected project "${project.name}". You can now chat with the AI coding agent!`
      );
    } catch (error) {
      console.error('Error handling project selection:', error);
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Failed to select project. Please try again.'), { parse_mode: 'MarkdownV2' });
    }
  }


  private async handleCancelCallback(chatId: number, messageId?: number): Promise<void> {
    try {
      // Delete the message with inline keyboard
      if (messageId) {
        await this.bot.telegram.deleteMessage(chatId, messageId);
      }

      await this.bot.telegram.sendMessage(chatId, '❌ Operation cancelled.');
    } catch (error) {
      console.error('Error handling cancel callback:', error);
    }
  }

  private async handleModelSelectCallback(data: string, chatId: number, messageId?: number): Promise<void> {
    try {
      const selectedPayload = data.replace('model_select:', '');
      const [selectedProviderRaw, selectedModelRaw] = selectedPayload.includes(':')
        ? selectedPayload.split(':', 2)
        : [undefined, selectedPayload];
      const selectedProvider = selectedProviderRaw as AgentProvider | undefined;
      const selectedModel = decodeURIComponent(selectedModelRaw) as AgentModel;
      const availableModels = await this.getSelectableModels();

      const modelInfo = selectedProvider
        ? availableModels.find((m) => m.provider === selectedProvider && m.value === selectedModel)
        : availableModels.find((m) => m.value === selectedModel);
      if (!modelInfo) {
        await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Invalid model selected.'), { parse_mode: 'MarkdownV2' });
        return;
      }

      const user = await this.storage.getUserSession(chatId);
      if (!user) {
        await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('No user session found.'), { parse_mode: 'MarkdownV2' });
        return;
      }

      const currentProvider = this.agentManager.provider;
      if (currentProvider === modelInfo.provider && user.currentModel === modelInfo.value) {
        if (messageId) {
          try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
        }
        await this.bot.telegram.sendMessage(chatId, `ℹ️ Already using **${modelInfo.provider} - ${modelInfo.displayName}**`, { parse_mode: 'Markdown' });
        return;
      }

      // Check if Agent is currently running and abort if needed
      let abortMessage = '';
      if (this.agentManager.isQueryRunning(chatId)) {
        const abortSuccess = await this.agentManager.abortQuery(chatId);
        if (abortSuccess) {
          abortMessage = '🛑 Current query has been stopped.\n';
        }
      }

      const providerChanged = currentProvider !== modelInfo.provider;
      if (providerChanged) {
        if (!this.agentManager.setProvider) {
          await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Provider switching is not supported in this runtime.'), { parse_mode: 'MarkdownV2' });
          return;
        }
        await this.agentManager.setProvider(modelInfo.provider);
        this.config.agent.provider = modelInfo.provider;
        // Provider sessions are not cross-compatible.
        delete user.sessionId;
      }

      user.setModel(modelInfo.value);
      await this.storage.saveUserSession(user);

      // Delete the selection message
      if (messageId) {
        try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
      }

      const details = providerChanged
        ? `✅ Model switched to **${modelInfo.provider} - ${modelInfo.displayName}**\n🧹 Session reset because provider changed.`
        : `✅ Model switched to **${modelInfo.provider} - ${modelInfo.displayName}**`;
      const finalMessage = abortMessage
        ? `${abortMessage}${details}\n🔄 Continue your conversation with the new model.`
        : details;

      await this.telegramSender.safeSendMessage(chatId, finalMessage);
    } catch (error) {
      console.error('Error handling model select callback:', error);
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Failed to change model. Please try again.'), { parse_mode: 'MarkdownV2' });
    }
  }

  private async handleDirectoryPickerCallback(data: string, chatId: number, messageId?: number): Promise<void> {
    const result = await this.fileBrowserHandler.handleDirectoryPickerCallback(data, chatId, messageId);

    if (result === null) {
      // Cancelled
      const user = await this.storage.getUserSession(chatId);
      if (user) {
        // If was in onboarding, mark as completed and go to idle
        if (!user.hasCompletedOnboarding()) {
          user.setOnboardingCompleted(true);
        }
        user.setState(UserState.Idle);
        await this.storage.saveUserSession(user);
      }
      await this.bot.telegram.sendMessage(chatId, '❌ Directory selection cancelled.');
    } else if (result === 'search') {
      // User wants to type a path - set state to WaitingPickerSearch
      const user = await this.storage.getUserSession(chatId);
      if (user) {
        user.setState(UserState.WaitingPickerSearch);
        await this.storage.saveUserSession(user);
      }
    } else if (typeof result === 'string') {
      // Directory selected - mark onboarding if needed, then create project
      const user = await this.storage.getUserSession(chatId);
      if (user && !user.hasCompletedOnboarding()) {
        user.setOnboardingCompleted(true);
        await this.storage.saveUserSession(user);
      }
      await this.projectHandler.createProjectFromPath(chatId, result);
    }
    // undefined = still browsing, do nothing
  }

  private async handleOnboardingCallback(ctx: Context, data: string, chatId: number, messageId?: number): Promise<void> {
    const user = await this.storage.getUserSession(chatId);
    if (!user) return;

    try {
      // Delete previous message for clean UI
      if (messageId) {
        try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
      }

      switch (data) {
        case 'onboarding_continue':
          user.setState(UserState.OnboardingDisclaimer);
          await this.storage.saveUserSession(user);
          await ctx.reply(MESSAGES.ONBOARDING.DISCLAIMER, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingDisclaimerKeyboard() });
          break;

        case 'onboarding_accept':
          user.setState(UserState.OnboardingModel);
          await this.storage.saveUserSession(user);
          await ctx.reply(MESSAGES.ONBOARDING.MODEL_SELECTION, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingModelKeyboard(user.currentModel, this.agentManager.provider) });
          break;

        case 'onboarding_decline':
          await ctx.reply(MESSAGES.ONBOARDING.DECLINE_WARNING, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingDisclaimerKeyboard() });
          break;

        case 'onboarding_model_done':
          user.setState(UserState.OnboardingProject);
          await this.storage.saveUserSession(user);
          await ctx.reply(MESSAGES.ONBOARDING.PROJECT_GUIDE, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingProjectKeyboard() });
          break;

        case 'onboarding_project_github':
          user.setOnboardingCompleted(true);
          user.setState(UserState.WaitingRepo);
          await this.storage.saveUserSession(user);
          await ctx.reply(MESSAGES.GITHUB_PROJECT_TEXT);
          break;

        case 'onboarding_project_local':
          user.setState(UserState.WaitingDirectory);
          await this.storage.saveUserSession(user);
          await this.fileBrowserHandler.startDirectoryPicker(chatId);
          break;

        case 'onboarding_skip':
          user.setOnboardingCompleted(true);
          user.setState(UserState.Idle);
          await this.storage.saveUserSession(user);
          await ctx.reply(MESSAGES.ONBOARDING.COMPLETED, { parse_mode: 'Markdown' });
          break;

        default:
          if (data.startsWith('onboarding_model:')) {
            const modelValue = data.replace('onboarding_model:', '') as AgentModel;
            const onboardingModels = await this.agentManager.getAvailableModels();
            const validOnboardingModel = onboardingModels.some((m) => m.value === modelValue);
            if (!validOnboardingModel) {
              await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Invalid model selected.'), { parse_mode: 'MarkdownV2' });
              return;
            }
            user.setModel(modelValue);
            await this.storage.saveUserSession(user);
            // Update keyboard with selection
            await ctx.reply(MESSAGES.ONBOARDING.MODEL_SELECTION, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingModelKeyboard(modelValue, this.agentManager.provider) });
          }
      }
    } catch (error) {
      console.error('Error handling onboarding callback:', error);
    }
  }

  private async getSelectableModels(): Promise<ModelInfo[]> {
    await this.agentManager.getAvailableModels();
    const models = getAllProviderModels();
    const unique = new Map<string, ModelInfo>();
    for (const model of models) {
      unique.set(`${model.provider}:${model.value}`, model);
    }
    return Array.from(unique.values());
  }
}
