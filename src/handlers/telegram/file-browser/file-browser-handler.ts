import { Context, Markup, Telegraf } from 'telegraf';
import { UserState, FileBrowsingState } from '../../../models/types';
import { IStorage } from '../../../storage/interface';
import { DirectoryManager } from '../../directory';
import { MessageFormatter } from '../../../utils/formatter';
import { Config } from '../../../config/config';
import { KeyboardFactory } from '../keyboards/keyboard-factory';
import { AuthService } from '../../../services/auth-service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { TelegramSender } from '../../../services/telegram-sender';

export class FileBrowserHandler {
  private fileBrowsingStates: Map<number, FileBrowsingState> = new Map();
  private pickerStates: Map<number, FileBrowsingState> = new Map();
  private searchResults: Map<number, string[]> = new Map();
  private authService: AuthService;
  private telegramSender: TelegramSender;

  constructor(
    private storage: IStorage,
    private directory: DirectoryManager,
    private formatter: MessageFormatter,
    private config: Config,
    private bot: Telegraf
  ) {
    this.authService = new AuthService(config);
    this.telegramSender = new TelegramSender(bot);
  }

  async handleLsCommand(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.storage.getUserSession(chatId);

    // Check if user exists and is in session
    if (!user || user.state !== UserState.InSession) {
      await ctx.reply(this.formatter.formatError('Please create a project first to browse files.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    // Check authentication for sensitive operations
    if (!this.authService.isUserAuthenticated(user)) {
      await ctx.reply(this.formatter.formatError(this.authService.getAuthErrorMessage()), { parse_mode: 'MarkdownV2' });
      return;
    }

    if (!user.activeProject) {
      await ctx.reply(this.formatter.formatError('No active project.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    const activeProject = await this.storage.getProject(user.activeProject, chatId);
    if (!activeProject || !activeProject.localPath) {
      await ctx.reply(this.formatter.formatError('Active project not found.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    try {
      // List directory contents
      const items = await this.directory.listDirectoryContents(activeProject.localPath, activeProject.localPath);

      // Initialize browsing state
      const browsingState: FileBrowsingState = {
        currentPath: activeProject.localPath,
        basePath: activeProject.localPath,
        currentPage: 1,
        itemsPerPage: 12,
        totalItems: items.length,
        items
      };

      // Store browsing state temporarily
      this.fileBrowsingStates.set(chatId, browsingState);

      // Send directory listing
      await this.sendDirectoryListing(chatId, browsingState);
    } catch (error) {
      await ctx.reply(this.formatter.formatError(`Failed to access directory: ${error instanceof Error ? error.message : 'Unknown error'}`), { parse_mode: 'MarkdownV2' });
    }
  }

  async handleFileBrowsingCallback(data: string, chatId: number, messageId?: number): Promise<void> {
    const browsingState = this.fileBrowsingStates.get(chatId);
    if (!browsingState) {
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('File browsing session has expired, please use /ls command again'), { parse_mode: 'MarkdownV2' });
      return;
    }

    try {
      if (data.startsWith('file:')) {
        // Handle file click
        const fileName = decodeURIComponent(data.substring(5));
        await this.handleFileClick(chatId, browsingState.currentPath, fileName);
      } else if (data.startsWith('directory:')) {
        // Handle directory click
        const dirName = decodeURIComponent(data.substring(10));
        await this.handleDirectoryClick(chatId, browsingState, dirName, messageId);
      } else if (data.startsWith('nav:')) {
        // Handle navigation
        await this.handleNavigation(chatId, browsingState, data.substring(4), messageId);
      }
    } catch (error) {
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError(`Operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`), { parse_mode: 'MarkdownV2' });
    }
  }

  private async handleFileClick(chatId: number, currentPath: string, fileName: string): Promise<void> {
    if (!this.config.workers.enabled || !this.config.workers.endpoint) {
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('File viewing feature is not enabled or configured'), { parse_mode: 'MarkdownV2' });
      return;
    }

    const filePath = path.join(currentPath, fileName);

    try {
      // Check if file is readable
      if (!(await this.directory.isFileReadable(filePath))) {
        await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('This file cannot be read (may be a binary file or too large)'), { parse_mode: 'MarkdownV2' });
        return;
      }

      // Read file content
      const content = await this.directory.readFileContent(filePath);
      if (!content) {
        await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Unable to read file content'), { parse_mode: 'MarkdownV2' });
        return;
      }

      // Upload to workers
      const language = this.directory.detectLanguage(fileName);
      const uploadData = {
        content,
        filename: fileName,
        language,
        chatid: chatId.toString()
      };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (this.config.workers.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.workers.apiKey}`;
      }

      const response = await fetch(`${this.config.workers.endpoint}/api/file`, {
        method: 'POST',
        headers,
        body: JSON.stringify(uploadData)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json() as { id: string };
      const miniAppUrl = `${this.config.workers.endpoint}/file?id=${result.id}`;

      // Create WebApp button
      const keyboard = Markup.inlineKeyboard([
        Markup.button.webApp('📄 View File', miniAppUrl)
      ]);

      await this.telegramSender.safeSendMessage(
        chatId,
        `📄 **${fileName}**\n\nClick the button below to view file content`,
        keyboard
      );
    } catch (error) {
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError(`File processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`), { parse_mode: 'MarkdownV2' });
    }
  }

  private async handleDirectoryClick(chatId: number, browsingState: FileBrowsingState, dirName: string, messageId?: number): Promise<void> {
    const newPath = path.join(browsingState.currentPath, dirName);

    // Validate that the new path is within the base path
    if (!this.directory.isPathWithinBase(newPath, browsingState.basePath)) {
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Access denied: cannot access paths outside the project directory'), { parse_mode: 'MarkdownV2' });
      return;
    }

    try {
      // List new directory contents
      const items = await this.directory.listDirectoryContents(newPath, browsingState.basePath);

      // Update browsing state
      const newBrowsingState: FileBrowsingState = {
        currentPath: newPath,
        basePath: browsingState.basePath,
        currentPage: 1,
        itemsPerPage: browsingState.itemsPerPage,
        totalItems: items.length,
        items
      };

      // Update browsing state in memory
      this.fileBrowsingStates.set(chatId, newBrowsingState);

      // Update the message
      if (messageId) {
        await this.updateDirectoryListing(chatId, messageId, newBrowsingState);
      } else {
        await this.sendDirectoryListing(chatId, newBrowsingState);
      }
    } catch (error) {
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError(`Failed to access directory: ${error instanceof Error ? error.message : 'Unknown error'}`), { parse_mode: 'MarkdownV2' });
    }
  }

  private async handleNavigation(chatId: number, browsingState: FileBrowsingState, action: string, messageId?: number): Promise<void> {
    try {
      let newBrowsingState = browsingState;

      if (action === 'parent') {
        // Go to parent directory
        const parentPath = path.dirname(browsingState.currentPath);

        // Validate that the parent path is within the base path
        if (parentPath !== browsingState.currentPath && this.directory.isPathWithinBase(parentPath, browsingState.basePath)) {
          const items = await this.directory.listDirectoryContents(parentPath, browsingState.basePath);
          newBrowsingState = {
            currentPath: parentPath,
            basePath: browsingState.basePath,
            currentPage: 1,
            itemsPerPage: browsingState.itemsPerPage,
            totalItems: items.length,
            items
          };
        } else if (parentPath !== browsingState.currentPath) {
          // Parent directory is outside allowed base path
          await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Already at project root directory, cannot access parent directory'), { parse_mode: 'MarkdownV2' });
          return;
        }
      } else if (action === 'refresh') {
        // Refresh current directory
        const items = await this.directory.listDirectoryContents(browsingState.currentPath, browsingState.basePath);
        newBrowsingState = {
          ...browsingState,
          totalItems: items.length,
          items
        };
      } else if (action.startsWith('page:')) {
        // Page navigation
        const page = parseInt(action.substring(5));
        newBrowsingState = {
          ...browsingState,
          currentPage: page
        };
      } else if (action === 'close') {
        // Close file browser
        this.fileBrowsingStates.delete(chatId);

        if (messageId) {
          await this.bot.telegram.deleteMessage(chatId, messageId);
        }
        await this.bot.telegram.sendMessage(chatId, 'File browser closed');
        return;
      }

      // Update browsing state in memory
      this.fileBrowsingStates.set(chatId, newBrowsingState);

      // Update the message
      if (messageId) {
        await this.updateDirectoryListing(chatId, messageId, newBrowsingState);
      } else {
        await this.sendDirectoryListing(chatId, newBrowsingState);
      }
    } catch (error) {
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError(`Navigation failed: ${error instanceof Error ? error.message : 'Unknown error'}`), { parse_mode: 'MarkdownV2' });
    }
  }

  private async sendDirectoryListing(chatId: number, browsingState: FileBrowsingState): Promise<void> {
    const message = this.formatDirectoryMessage(browsingState);
    const keyboard = KeyboardFactory.createDirectoryKeyboard(browsingState);

    const sentMessage = await this.telegramSender.safeSendMessage(chatId, message, keyboard);

    // Update browsing state with message ID
    const updatedState = { ...browsingState, messageId: sentMessage.message_id };
    this.fileBrowsingStates.set(chatId, updatedState);
  }

  private async updateDirectoryListing(chatId: number, messageId: number, browsingState: FileBrowsingState): Promise<void> {
    const message = this.formatDirectoryMessage(browsingState);
    const keyboard = KeyboardFactory.createDirectoryKeyboard(browsingState);

    try {
      await this.telegramSender.safeEditMessage(chatId, messageId, message, keyboard);
    } catch (error) {
      // If edit fails, send new message
      await this.sendDirectoryListing(chatId, browsingState);
    }
  }

  private formatDirectoryMessage(browsingState: FileBrowsingState): string {
    const { currentPath, currentPage, itemsPerPage, totalItems, items } = browsingState;

    // Get relative path for display
    const displayPath = currentPath.replace(process.cwd(), '').replace(/^\/+/, '') || '/';

    // Calculate pagination
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
    const pageItems = items.slice(startIndex, endIndex);

    let message = `📁 **${displayPath}**\n\n`;

    if (totalPages > 1) {
      message += `📄 Page ${currentPage}/${totalPages}\n`;
    }

    const dirCount = items.filter(item => item.type === 'directory').length;
    const fileCount = items.filter(item => item.type === 'file').length;
    message += `📊 ${dirCount} directories, ${fileCount} files\n\n`;

    // Add items
    if (pageItems.length === 0) {
      message += '_Directory is empty_';
    } else {
      for (const item of pageItems) {
        const icon = item.icon;
        const name = item.name;
        message += `${icon} ${name}\n`;
      }
    }

    return message;
  }

  // Directory picker methods for project selection
  async startDirectoryPicker(chatId: number, startPath?: string): Promise<void> {
    const initialPath = startPath || os.homedir();

    try {
      const items = await this.directory.listDirectoryContents(initialPath);

      const browsingState: FileBrowsingState = {
        currentPath: initialPath,
        basePath: '/', // Allow navigating anywhere
        currentPage: 1,
        itemsPerPage: 12,
        totalItems: items.length,
        items
      };

      this.pickerStates.set(chatId, browsingState);
      await this.sendPickerListing(chatId, browsingState);
    } catch (error) {
      await this.bot.telegram.sendMessage(
        chatId,
        this.formatter.formatError(`Failed to access directory: ${error instanceof Error ? error.message : 'Unknown error'}`),
        { parse_mode: 'MarkdownV2' }
      );
    }
  }

  async handleDirectoryPickerCallback(data: string, chatId: number, messageId?: number): Promise<string | null | undefined | 'search'> {
    // Handle search-related callbacks that don't need browsingState
    if (data === 'pick_search_cancel') {
      this.searchResults.delete(chatId);
      if (messageId) {
        try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
      }
      await this.reshowPicker(chatId);
      return undefined;
    }
    if (data.startsWith('pick_goto:')) {
      const encoded = data.substring(10);
      const results = this.searchResults.get(chatId);
      if (results) {
        const match = results.find(r => Buffer.from(r).toString('base64').substring(0, 49) === encoded);
        if (match) {
          this.searchResults.delete(chatId);
          if (messageId) {
            try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
          }
          await this.navigatePickerTo(chatId, match);
          return undefined;
        }
      }
      return undefined;
    }

    const browsingState = this.pickerStates.get(chatId);
    if (!browsingState) {
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError('Directory picker session expired. Please try again.'), { parse_mode: 'MarkdownV2' });
      return null;
    }

    try {
      if (data === 'pick_select') {
        // User selected current directory
        const selectedPath = browsingState.currentPath;
        this.pickerStates.delete(chatId);

        if (messageId) {
          try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
        }

        return selectedPath;
      } else if (data === 'pick_search') {
        // Prompt user to type a path or search term
        if (messageId) {
          try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
        }
        await this.bot.telegram.sendMessage(chatId, '🔍 Type a folder name to search or an absolute path:\n\nExamples:\n• `myproject` — search by name\n• `/Users/jones/projects` — go to path', { parse_mode: 'Markdown' });
        return 'search'; // Signal to caller to set WaitingPickerSearch state
      } else if (data === 'pick_cancel') {
        this.pickerStates.delete(chatId);

        if (messageId) {
          try { await this.bot.telegram.deleteMessage(chatId, messageId); } catch {}
        }

        return null;
      } else if (data.startsWith('pick_dir:')) {
        const dirName = decodeURIComponent(data.substring(9));
        const newPath = path.join(browsingState.currentPath, dirName);

        const items = await this.directory.listDirectoryContents(newPath);
        const newState: FileBrowsingState = {
          currentPath: newPath,
          basePath: '/',
          currentPage: 1,
          itemsPerPage: browsingState.itemsPerPage,
          totalItems: items.length,
          items
        };

        this.pickerStates.set(chatId, newState);

        if (messageId) {
          await this.updatePickerListing(chatId, messageId, newState);
        } else {
          await this.sendPickerListing(chatId, newState);
        }
      } else if (data.startsWith('pick_nav:')) {
        const action = data.substring(9);

        if (action === 'parent') {
          const parentPath = path.dirname(browsingState.currentPath);
          if (parentPath !== browsingState.currentPath) {
            const items = await this.directory.listDirectoryContents(parentPath);
            const newState: FileBrowsingState = {
              currentPath: parentPath,
              basePath: '/',
              currentPage: 1,
              itemsPerPage: browsingState.itemsPerPage,
              totalItems: items.length,
              items
            };

            this.pickerStates.set(chatId, newState);

            if (messageId) {
              await this.updatePickerListing(chatId, messageId, newState);
            } else {
              await this.sendPickerListing(chatId, newState);
            }
          }
        } else if (action.startsWith('page:')) {
          const page = parseInt(action.substring(5));
          const newState = { ...browsingState, currentPage: page };
          this.pickerStates.set(chatId, newState);

          if (messageId) {
            await this.updatePickerListing(chatId, messageId, newState);
          } else {
            await this.sendPickerListing(chatId, newState);
          }
        }
      }
    } catch (error) {
      await this.bot.telegram.sendMessage(
        chatId,
        this.formatter.formatError(`Navigation failed: ${error instanceof Error ? error.message : 'Unknown error'}`),
        { parse_mode: 'MarkdownV2' }
      );
    }

    return undefined; // Continue browsing (not a terminal action)
  }

  private async sendPickerListing(chatId: number, browsingState: FileBrowsingState): Promise<void> {
    const message = this.formatPickerMessage(browsingState);
    const keyboard = KeyboardFactory.createDirectoryPickerKeyboard(browsingState);

    const sentMessage = await this.telegramSender.safeSendMessage(chatId, message, keyboard);
    const updatedState = { ...browsingState, messageId: sentMessage.message_id };
    this.pickerStates.set(chatId, updatedState);
  }

  private async updatePickerListing(chatId: number, messageId: number, browsingState: FileBrowsingState): Promise<void> {
    const message = this.formatPickerMessage(browsingState);
    const keyboard = KeyboardFactory.createDirectoryPickerKeyboard(browsingState);

    try {
      await this.telegramSender.safeEditMessage(chatId, messageId, message, keyboard);
    } catch (error) {
      await this.sendPickerListing(chatId, browsingState);
    }
  }

  async handlePickerSearchInput(chatId: number, query: string): Promise<boolean> {
    const trimmed = query.trim();

    // If it's an absolute path, navigate directly
    if (trimmed.startsWith('/')) {
      if (await this.directory.validateDirectory(trimmed)) {
        return this.navigatePickerTo(chatId, trimmed);
      }
      await this.bot.telegram.sendMessage(chatId, this.formatter.formatError(`Directory not found: ${trimmed}`), { parse_mode: 'MarkdownV2' });
      return this.reshowPicker(chatId);
    }

    // Otherwise, search for matching directories from home
    await this.bot.telegram.sendMessage(chatId, `🔍 Searching for "${trimmed}"...`);

    const results = await this.searchDirectories(os.homedir(), trimmed);

    if (results.length === 0) {
      await this.bot.telegram.sendMessage(chatId, `No directories matching "${trimmed}" found.`);
      return this.reshowPicker(chatId);
    }

    // Show results as a list of buttons
    const keyboard = results.slice(0, 20).map(dir => [
      Markup.button.callback(
        `📁 ${dir.replace(os.homedir(), '~')}`,
        `pick_goto:${Buffer.from(dir).toString('base64').substring(0, 49)}`
      )
    ]);
    keyboard.push([Markup.button.callback('❌ Cancel search', 'pick_search_cancel')]);

    // Store the result paths for lookup
    this.searchResults.set(chatId, results.slice(0, 20));

    await this.bot.telegram.sendMessage(
      chatId,
      `🔍 Found ${results.length} match${results.length > 1 ? 'es' : ''} for "${trimmed}":`,
      { reply_markup: Markup.inlineKeyboard(keyboard).reply_markup }
    );
    return true;
  }

  private async searchDirectories(root: string, query: string): Promise<string[]> {
    const lowerQuery = query.toLowerCase();

    return new Promise((resolve) => {
      // Use system `find` for speed — case-insensitive, dirs only, max depth 5, prune heavy dirs
      const args = [
        root,
        '-maxdepth', '5',
        '-type', 'd',
        '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', '__pycache__', '-o', '-name', '.venv', '-o', '-name', 'venv', ')',
        '-prune', '-o',
        '-type', 'd',
        '-iname', `*${query}*`,
        '-print',
      ];

      const proc = execFile('find', args, { timeout: 3000, maxBuffer: 1024 * 256 }, (error, stdout) => {
        if (!stdout) {
          resolve([]);
          return;
        }

        const results = stdout.trim().split('\n').filter(Boolean).slice(0, 20);

        // Sort: exact name matches first, then by path depth
        results.sort((a, b) => {
          const nameA = path.basename(a).toLowerCase();
          const nameB = path.basename(b).toLowerCase();
          const exactA = nameA === lowerQuery ? 0 : 1;
          const exactB = nameB === lowerQuery ? 0 : 1;
          if (exactA !== exactB) return exactA - exactB;
          return a.split('/').length - b.split('/').length;
        });

        resolve(results);
      });

      // Kill if still running after 3s
      setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
    });
  }

  private async navigatePickerTo(chatId: number, dirPath: string): Promise<boolean> {
    const items = await this.directory.listDirectoryContents(dirPath);
    const newState: FileBrowsingState = {
      currentPath: dirPath,
      basePath: '/',
      currentPage: 1,
      itemsPerPage: 12,
      totalItems: items.length,
      items
    };
    this.pickerStates.set(chatId, newState);
    await this.sendPickerListing(chatId, newState);
    return true;
  }

  private async reshowPicker(chatId: number): Promise<boolean> {
    const state = this.pickerStates.get(chatId);
    if (state) {
      await this.sendPickerListing(chatId, state);
    }
    return false;
  }

  private formatPickerMessage(browsingState: FileBrowsingState): string {
    const { currentPath, currentPage, itemsPerPage, items } = browsingState;

    const dirCount = items.filter(item => item.type === 'directory').length;
    const totalPages = Math.ceil(dirCount / itemsPerPage) || 1;

    let message = `📂 **Select a directory**\n\n`;
    message += `📍 **${currentPath}**\n`;
    message += `📁 ${dirCount} subdirectories\n\n`;
    message += `Navigate into a folder or tap "Select This Directory" to choose the current location.`;

    if (totalPages > 1) {
      message += `\n\n📄 Page ${currentPage}/${totalPages}`;
    }

    return message;
  }
}