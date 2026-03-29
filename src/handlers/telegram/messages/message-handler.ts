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

  async handleTextMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message || !('text' in ctx.message)) return;
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    let user = await this.storage.getUserSession(chatId);
    if (!user) {
      user = new UserSessionModel(chatId);
      await this.storage.saveUserSession(user);
    }

    switch (user.state) {
      case UserState.WaitingRepo:
        await this.projectHandler.handleRepoInput(ctx, user, text);
        break;
      case UserState.WaitingDirectory:
        await this.projectHandler.handleDirectoryInput(ctx, user, text);
        break;
      case UserState.WaitingPickerSearch:
        if (this.fileBrowserHandler) {
          await this.fileBrowserHandler.handlePickerSearchInput(chatId, text);
          user.setState(UserState.WaitingDirectory);
          await this.storage.saveUserSession(user);
        }
        break;
      case UserState.WaitingASREdit:
        await this.handleASREditInput(ctx, user, text);
        break;
      case UserState.InSession:
        if (!user.hasSelectedModel) {
          await ctx.reply(
            'Please choose a model first before sending prompts:',
            KeyboardFactory.createModelSelectionKeyboard(user.currentModel, this.agentManager.provider, getAllProviderModels())
          );
          break;
        }
        await this.handleSessionInput(ctx, user, text);
        break;
      default:
        if (this.github.isGitHubURL(text)) {
          await this.projectHandler.startProjectCreation(ctx, user, text);
        } else if (user.state === UserState.Idle) {
          await ctx.reply('Selecione um projeto com /listproject para começar, ou crie um novo com /createproject.');
        }
    }
  }

  async handleSessionInput(ctx: Context, user: UserSessionModel, text: string): Promise<void> {
    try {
      await ctx.reply('Processing...', KeyboardFactory.createCompletionKeyboard());
      await this.agentManager.addMessageToStream(user.chatId, text);
    } catch (error) {
      await ctx.reply(this.formatter.formatError(MESSAGES.ERRORS.SEND_INPUT_FAILED(error instanceof Error ? error.message : 'Unknown error')), { parse_mode: 'MarkdownV2' });
    }
  }

  async handlePhotoMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message || !('photo' in ctx.message)) return;
    const chatId = ctx.chat.id;

    const user = await this.storage.getUserSession(chatId);
    if (!user) return;

    if (user.state !== UserState.InSession) {
      await ctx.reply(this.formatter.formatError('You must be in an active session to send images.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    try {
      // Get the largest photo (last element)
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1]!;
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);

      const response = await fetch(fileLink.toString());
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');

      const caption = 'caption' in ctx.message ? (ctx.message.caption as string) : undefined;

      await ctx.reply('Processing image...', KeyboardFactory.createCompletionKeyboard());
      await this.agentManager.addImageMessageToStream(chatId, base64Data, 'image/jpeg', caption);
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to process image. Please try again.'), { parse_mode: 'MarkdownV2' });
      console.error('Error processing photo:', error);
    }
  }

  async handleVoiceMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message || !('voice' in ctx.message)) return;
    const chatId = ctx.chat.id;

    const user = await this.storage.getUserSession(chatId);
    if (!user) return;

    if (user.state !== UserState.InSession) {
      await ctx.reply(this.formatter.formatError('You must be in an active session to send voice messages.'), { parse_mode: 'MarkdownV2' });
      return;
    }

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
        await ctx.reply('Could not recognize speech from the voice message.');
        return;
      }

      await this.storage.storePendingASR(chatId, text);
      await ctx.reply(`🎤 Speech recognized:`);
      await ctx.reply(text, KeyboardFactory.createASRConfirmKeyboard());
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to process voice message. Please try again.'), { parse_mode: 'MarkdownV2' });
      console.error('Error processing voice message:', error);
    }
  }


  async handleVideoMessage(ctx: Context): Promise<void> {
    if (!ctx.chat || !ctx.message) return;
    const chatId = ctx.chat.id;

    const user = await this.storage.getUserSession(chatId);
    if (!user) return;

    if (user.state !== UserState.InSession) {
      await ctx.reply('Você precisa estar em uma sessão ativa para enviar vídeos.');
      return;
    }

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
        await ctx.reply('Não foi possível processar o vídeo.');
        return;
      }

      await ctx.reply('🎬 Processando vídeo...', KeyboardFactory.createCompletionKeyboard());

      // Download video
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const response = await fetch(fileLink.toString());
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');

      // Send as image message with video indicator in caption
      const videoCaption = caption 
        ? `[VIDEO] ${caption}` 
        : '[VIDEO] Vídeo enviado pelo usuário para análise';

      await this.agentManager.addImageMessageToStream(chatId, base64Data, 'image/jpeg', videoCaption);
    } catch (error) {
      await ctx.reply('Falha ao processar vídeo. Tente novamente.');
      console.error('Error processing video message:', error);
    }
  }

  async handleASREditInput(ctx: Context, user: UserSessionModel, text: string): Promise<void> {
    try {
      // Clear pending ASR and restore session state
      await this.storage.deletePendingASR(user.chatId);
      user.setState(UserState.InSession);
      await this.storage.saveUserSession(user);

      await ctx.reply('Processing...', KeyboardFactory.createCompletionKeyboard());
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
