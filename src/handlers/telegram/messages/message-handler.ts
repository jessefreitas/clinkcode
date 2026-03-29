import { Context, Telegraf } from 'telegraf';
import { UserSessionModel } from '../../../models/user-session';
import { UserState, PermissionMode, getAllProviderModels } from '../../../models/types';
import { IStorage } from '../../../storage/interface';
import { GitHubManager } from '../../github';
import { MessageFormatter } from '../../../utils/formatter';
import { MESSAGES } from '../../../constants/messages';
import { ProjectHandler } from '../project/project-handler';
import { FileBrowserHandler } from '../file-browser/file-browser-handler';
import { TelegramSender } from '../../../services/telegram-sender';
import { KeyboardFactory } from '../keyboards/keyboard-factory';
import { Config } from '../../../config/config';
import { IAgentManager } from '../../agent-manager';
import { AgentMessage } from '../../../models/agent-message';
import * as fs from 'fs';

export class MessageHandler {
  private telegramSender: TelegramSender;

  constructor(
    private storage: IStorage,
    private github: GitHubManager,
    private formatter: MessageFormatter,
    private agentManager: IAgentManager,
    private projectHandler: ProjectHandler,
    private bot: Telegraf,
    private config: Config,
    private fileBrowserHandler?: FileBrowserHandler
  ) {
    this.telegramSender = new TelegramSender(bot);
  }

  private async ensureAutoSession(chatId: number): Promise<UserSessionModel> {
    let user = await this.storage.getUserSession(chatId);
    if (!user) {
      user = new UserSessionModel(chatId);
    }

    const needsSession = user.state !== UserState.InSession || !user.hasSelectedModel;

    if (needsSession) {
      // Auto-create a working directory for the user
      const workDir = `${this.config.workDir.workDir}/${chatId}`;
      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
      }

      // Set default model if not set or still on codex
      if (!user.currentModel || user.currentModel.startsWith('gpt-')) {
        user.currentModel = 'claude-sonnet-4-6';
      }

      user.hasSelectedModel = true;
      user.projectPath = workDir;
      user.setState(UserState.InSession);
      await this.storage.saveUserSession(user);
    }

    return user;
  }

  async handleTextMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message || !('text' in ctx.message)) return;
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    let user = await this.storage.getUserSession(chatId);
    if (!user) {
      user = new UserSessionModel(chatId);
      await this.storage.saveUserSession(user);
    }

    // Handle special flow states first
    switch (user.state) {
      case UserState.WaitingRepo:
        await this.projectHandler.handleRepoInput(ctx, user, text);
        return;
      case UserState.WaitingDirectory:
        await this.projectHandler.handleDirectoryInput(ctx, user, text);
        return;
      case UserState.WaitingPickerSearch:
        if (this.fileBrowserHandler) {
          await this.fileBrowserHandler.handlePickerSearchInput(chatId, text);
          user.setState(UserState.WaitingDirectory);
          await this.storage.saveUserSession(user);
        }
        return;
      case UserState.WaitingASREdit:
        await this.handleASREditInput(ctx, user, text);
        return;
    }

    // If it's a GitHub URL, start project creation
    if (this.github.isGitHubURL(text)) {
      await this.projectHandler.startProjectCreation(ctx, user, text);
      return;
    }

    // All other cases: free conversation mode - auto-session
    const sessionUser = await this.ensureAutoSession(chatId);
    await this.handleSessionInput(ctx, sessionUser, text);
  }

  async handleSessionInput(ctx: Context, user: UserSessionModel, text: string): Promise<void> {
    try {
      await ctx.reply('Processando...', KeyboardFactory.createCompletionKeyboard());
      await this.agentManager.addMessageToStream(user.chatId, text);
    } catch (error) {
      await ctx.reply(this.formatter.formatError(MESSAGES.ERRORS.SEND_INPUT_FAILED(error instanceof Error ? error.message : 'Unknown error')), { parse_mode: 'MarkdownV2' });
    }
  }

  async handlePhotoMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message || !('photo' in ctx.message)) return;
    const chatId = ctx.chat.id;

    const user = await this.ensureAutoSession(chatId);

    try {
      // Get the largest photo (last element)
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1]!;
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);

      const response = await fetch(fileLink.toString());
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');

      const caption = 'caption' in ctx.message ? (ctx.message.caption as string) : undefined;

      await ctx.reply('Processando imagem...', KeyboardFactory.createCompletionKeyboard());
      await this.agentManager.addImageMessageToStream(chatId, base64Data, 'image/jpeg', caption);
    } catch (error) {
      await ctx.reply('Falha ao processar imagem. Tente novamente.');
      console.error('Error processing photo:', error);
    }
  }

  async handleVoiceMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message || !('voice' in ctx.message)) return;
    const chatId = ctx.chat.id;

    const user = await this.ensureAutoSession(chatId);

    if (!this.config.asr.enabled) {
      await ctx.reply(this.formatter.formatError('Voice message is not supported. ASR service is not enabled.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    try {
      const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
      const audioResponse = await fetch(fileLink.toString());
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer]), 'voice.ogg');

      const asrResponse = await fetch(`${this.config.asr.endpoint}/asr`, {
        method: 'POST',
        body: formData,
      });

      if (!asrResponse.ok) {
        throw new Error(`ASR service returned ${asrResponse.status}`);
      }

      const result = await asrResponse.json() as { text: string };
      const text = result.text;

      if (!text) {
        await ctx.reply('Nao foi possivel reconhecer a fala. Tente novamente.');
        return;
      }

      await this.storage.storePendingASR(chatId, text);
      await ctx.reply(`\u{1F3A4} Speech recognized:`);
      await ctx.reply(text, KeyboardFactory.createASRConfirmKeyboard());
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Falha ao processar mensagem de voz. Tente novamente.'), { parse_mode: 'MarkdownV2' });
      console.error('Error processing voice message:', error);
    }
  }


  async handleVideoMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message) return;
    const chatId = ctx.chat.id;

    const user = await this.ensureAutoSession(chatId);

    try {
      // Extract video from message
      let fileId: string | undefined;
      let caption: string | undefined;

      if ('video' in ctx.message) {
        fileId = ctx.message.video.file_id;
        caption = ctx.message.caption;
      } else if ('animation' in ctx.message) {
        fileId = (ctx.message as any).animation.file_id;
        caption = ctx.message.caption;
      } else if ('video_note' in ctx.message) {
        fileId = (ctx.message as any).video_note.file_id;
      }

      if (!fileId) {
        await ctx.reply('Nao foi possivel processar o video.');
        return;
      }

      await ctx.reply('Processando video...', KeyboardFactory.createCompletionKeyboard());

      // Download video
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const response = await fetch(fileLink.toString());
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');

      // Send as image message with video indicator in caption
      const videoCaption = caption
        ? `[VIDEO] ${caption}`
        : '[VIDEO] Video enviado para analise';

      await this.agentManager.addImageMessageToStream(chatId, base64Data, 'image/jpeg', videoCaption);
    } catch (error) {
      await ctx.reply('Falha ao processar video. Tente novamente.');
      console.error('Error processing video message:', error);
    }
  }

  async handleASREditInput(ctx: Context, user: UserSessionModel, text: string): Promise<void> {
    try {
      // Clear pending ASR and restore session state
      await this.storage.deletePendingASR(user.chatId);
      user.setState(UserState.InSession);
      await this.storage.saveUserSession(user);

      await ctx.reply('Processando...', KeyboardFactory.createCompletionKeyboard());
      await this.agentManager.addMessageToStream(user.chatId, text);
    } catch (error) {
      await ctx.reply(this.formatter.formatError(MESSAGES.ERRORS.SEND_INPUT_FAILED(error instanceof Error ? error.message : 'Unknown error')), { parse_mode: 'MarkdownV2' });
    }
  }

  async handleRegularMessage(chatId: number, message: AgentMessage, permissionMode?: PermissionMode): Promise<void> {
    await this.sendFormattedMessage(chatId, message, permissionMode);
  }


  async sendFormattedMessage(chatId: number, message: AgentMessage, permissionMode?: PermissionMode): Promise<void> {
    try {
      const formattedMessage = await this.formatter.formatAgentMessage(message, permissionMode);
      if (formattedMessage) {
        await this.telegramSender.safeSendMessage(chatId, formattedMessage);
      }
    } catch (error) {
      console.error('Error handling Agent message:', error);
    }
  }

  private async sendHelp(ctx: Context): Promise<void> {
    const helpText = MESSAGES.HELP_TEXT;
    await ctx.reply(helpText);
  }

}
