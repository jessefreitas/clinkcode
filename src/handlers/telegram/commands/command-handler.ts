import { Context, Markup, Input } from 'telegraf';
import { UserSessionModel } from '../../../models/user-session';
import { UserState, PermissionMode, ClaudeModel, AVAILABLE_MODELS } from '../../../models/types';
import { IStorage } from '../../../storage/interface';
import { MessageFormatter } from '../../../utils/formatter';
import { MESSAGES } from '../../../constants/messages';
import { KeyboardFactory } from '../keyboards/keyboard-factory';
import { ClaudeManager } from '../../claude';
import { AuthService } from '../../../services/auth-service';
import { Config } from '../../../config/config';
import { TelegramSender } from '../../../services/telegram-sender';
import { ClaudeSessionReader } from '../../../utils/claude-session-reader';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { html as diff2htmlHtml } from 'diff2html';

export class CommandHandler {
  private authService: AuthService;
  private telegramSender: TelegramSender;
  private sessionReader: ClaudeSessionReader;

  constructor(
    private storage: IStorage,
    private formatter: MessageFormatter,
    private claudeSDK: ClaudeManager,
    private config: Config,
    private bot: any
  ) {
    this.authService = new AuthService(config);
    this.telegramSender = new TelegramSender(bot);
    this.sessionReader = new ClaudeSessionReader();
  }

  async handleStart(ctx: Context): Promise<void> {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;

    let user = await this.storage.getUserSession(chatId);

    if (!user) {
      // New user - create session and start onboarding
      user = new UserSessionModel(chatId);
      user.setState(UserState.OnboardingWelcome);
      await this.storage.saveUserSession(user);

      await ctx.reply(
        MESSAGES.ONBOARDING.WELCOME,
        { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingWelcomeKeyboard() }
      );
      return;
    }

    if (!user.hasCompletedOnboarding()) {
      // Incomplete onboarding - resume from current state
      await this.resumeOnboarding(ctx, user);
      return;
    }

    // Existing user - short welcome message
    await ctx.reply(MESSAGES.ONBOARDING.WELCOME_RETURNING, { parse_mode: 'Markdown' });
  }

  async handleResetOnboarding(ctx: Context): Promise<void> {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;

    let user = await this.storage.getUserSession(chatId);
    if (!user) {
      user = new UserSessionModel(chatId);
    }

    user.setOnboardingCompleted(false);
    user.setState(UserState.OnboardingWelcome);
    await this.storage.saveUserSession(user);

    await ctx.reply(
      MESSAGES.ONBOARDING.WELCOME,
      { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingWelcomeKeyboard() }
    );
  }

  private async resumeOnboarding(ctx: Context, user: UserSessionModel): Promise<void> {
    switch (user.state) {
      case UserState.OnboardingWelcome:
        await ctx.reply(MESSAGES.ONBOARDING.WELCOME, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingWelcomeKeyboard() });
        break;
      case UserState.OnboardingDisclaimer:
        await ctx.reply(MESSAGES.ONBOARDING.DISCLAIMER, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingDisclaimerKeyboard() });
        break;
      case UserState.OnboardingModel:
        await ctx.reply(MESSAGES.ONBOARDING.MODEL_SELECTION, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingModelKeyboard(user.currentModel) });
        break;
      case UserState.OnboardingProject:
        await ctx.reply(MESSAGES.ONBOARDING.PROJECT_GUIDE, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingProjectKeyboard() });
        break;
      default:
        // Unknown state - restart onboarding
        user.setState(UserState.OnboardingWelcome);
        await this.storage.saveUserSession(user);
        await ctx.reply(MESSAGES.ONBOARDING.WELCOME, { parse_mode: 'Markdown', ...KeyboardFactory.createOnboardingWelcomeKeyboard() });
    }
  }

  async handleCreateProject(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    if (user.state !== UserState.Idle) {
      await ctx.reply(this.formatter.formatError(MESSAGES.ERRORS.COMPLETE_CURRENT_OPERATION), { parse_mode: 'MarkdownV2' });
      return;
    }

    // Check authentication for sensitive operations
    if (!this.authService.isUserAuthenticated(user)) {
      await ctx.reply(this.formatter.formatError(this.authService.getAuthErrorMessage()), { parse_mode: 'MarkdownV2' });
      return;
    }

    user.setState(UserState.WaitingProjectType);
    await this.storage.saveUserSession(user);

    await ctx.reply(MESSAGES.CREATE_PROJECT_TEXT, KeyboardFactory.createProjectTypeKeyboard());
  }

  async handleListProject(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    try {
      // Read projects from Claude Code's ~/.claude/projects/ directory
      const claudeProjects = await this.sessionReader.listAllProjects(20);

      if (claudeProjects.length === 0) {
        const text = `📋 *Projects*\n\nNo existing projects found. Create one to get started:`;
        await ctx.reply(text, { parse_mode: 'Markdown', ...KeyboardFactory.createClaudeProjectListKeyboard([]) });
        return;
      }

      const listText = `📋 *Projects (${claudeProjects.length})*\n\nSelect a project or create a new one:`;
      await ctx.reply(listText, { parse_mode: 'Markdown', ...KeyboardFactory.createClaudeProjectListKeyboard(claudeProjects) });
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to load projects. Please try again.'), { parse_mode: 'MarkdownV2' });
      console.error('Error loading projects:', error);
    }
  }

  async handleExitProject(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    if (user.state === UserState.Idle || !user.activeProject) {
      await ctx.reply(this.formatter.formatError('No active project to exit.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    try {
      // Get project name from storage
      const project = await this.storage.getProject(user.activeProject, chatId);
      const projectName = project?.name || 'Unknown Project';
      
      // Clean up active streams before ending session
      this.claudeSDK.abortQuery(chatId);
      
      user.endSession();
      user.clearActiveProject();
      user.setState(UserState.Idle);
      await this.storage.saveUserSession(user);
      
      await ctx.reply(`👋 Exited project "${projectName}". You can create a new project or select another one.`);
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to exit project. Please try again.'), { parse_mode: 'MarkdownV2' });
      console.error('Error exiting project:', error);
    }
  }

  async handleHelp(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    await this.telegramSender.safeSendMessage(ctx.chat.id, MESSAGES.HELP_TEXT);
  }


  async handleStatus(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    const session = await this.storage.getUserSession(chatId);
    const sessionStatus = session?.active ? 'Active' : 'Inactive';
    
    // Get project count and details from storage
    const projects = await this.storage.getUserProjects(chatId);
    const projectCount = projects.length;
    
    // Get active project details
    let activeProjectName = 'None';
    let activeProjectType = 'None';
    let activeProjectPath = 'None';
    
    if (user.activeProject) {
      try {
        const project = await this.storage.getProject(user.activeProject, chatId);
        if (project) {
          activeProjectName = project.name;
          activeProjectType = project.repoUrl ? 'GitHub Repository' : 'Local Directory';
          activeProjectPath = project.localPath || 'Unknown';
        }
      } catch (error) {
        console.error('Error getting active project details:', error);
      }
    }

    // Authentication status
    const authStatus = this.authService.isSecretRequired() 
      ? (user.isAuthenticated() ? 'Authenticated' : 'Not authenticated')
      : 'Not required';

    const statusText = MESSAGES.STATUS_TEXT(
      user.state,
      sessionStatus,
      projectCount,
      activeProjectName,
      activeProjectType,
      activeProjectPath,
      user.permissionMode,
      authStatus,
      user.sessionId ? 'Yes' : 'No'
    );
    await this.telegramSender.safeSendMessage(ctx.chat.id, statusText);
  }



  async handleClear(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    try {
      delete user.sessionId;
      await this.storage.saveUserSession(user);
      await this.claudeSDK.abortQuery(chatId);

      await ctx.reply('✅ Session cleared. Your Claude Code session has been reset.');
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to clear session. Please try again.'), { parse_mode: 'MarkdownV2' });
      console.error('Error clearing session:', error);
    }
  }

  async handleResume(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    // Must have an active project to resume a session
    if (!user.activeProject || !user.projectPath) {
      await ctx.reply(this.formatter.formatError('No active project. Please select a project first with /listproject.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    try {
      // user.activeProject is the encoded project ID (path with / replaced by -)
      const sessions = await this.sessionReader.listProjectSessions(user.activeProject, 10);

      if (sessions.length === 0) {
        await ctx.reply('📋 No Claude Code sessions found for this project.\n\nStart chatting to create a new session!');
        return;
      }

      const listText = `📋 Claude Code Sessions (${sessions.length})\n\nSelect a session to resume:`;
      await ctx.reply(listText, KeyboardFactory.createSessionListKeyboard(sessions));
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to load sessions. Please try again.'), { parse_mode: 'MarkdownV2' });
      console.error('Error loading sessions:', error);
    }
  }

  async handleAbort(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    try {
      const success = await this.claudeSDK.abortQuery(chatId);

      if (success) {
        await ctx.reply('🛑 Query aborted successfully. You can send a new message now.');
      } else {
        await ctx.reply('ℹ️ No active query to abort. All queries have completed.');
      }
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to abort query. Please try again.'), { parse_mode: 'MarkdownV2' });
    }
  }

  async handleAuth(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    // If secret is not required, inform user
    if (!this.authService.isSecretRequired()) {
      await ctx.reply('🔓 No authentication required. Secret verification is disabled.');
      return;
    }

    // If already authenticated, inform user
    if (user.isAuthenticated()) {
      await ctx.reply('✅ You are already authenticated.');
      return;
    }

    // Check if message contains secret
    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const secret = messageText.replace('/auth', '').trim();

    if (!secret) {
      await ctx.reply(this.authService.getSecretPromptMessage());
      return;
    }

    // Verify secret
    if (this.authService.authenticateUser(user, secret)) {
      await this.storage.saveUserSession(user);
      await ctx.reply('✅ Authentication successful! You can now access sensitive operations.');
    } else {
      await ctx.reply(this.formatter.formatError('❌ Invalid secret token. Please try again.'), { parse_mode: 'MarkdownV2' });
    }
  }

  async handlePermissionModeChange(ctx: Context, mode: PermissionMode): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    if (user.state !== UserState.InSession) {
      await ctx.reply(this.formatter.formatError('You must be in an active session to change permission mode.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    try {
      // Check if Claude is currently running and abort if needed
      let abortMessage = '';
      if (this.claudeSDK.isQueryRunning(chatId)) {
        const abortSuccess = await this.claudeSDK.abortQuery(chatId);
        
        if (abortSuccess) {
          abortMessage = '🛑 Current Claude has been stopped.\n';
        }
      }

      user.setPermissionMode(mode);
      await this.storage.saveUserSession(user);

      const modeNames = {
        [PermissionMode.Default]: 'Default - Standard behavior with permission prompts for each tool on first use',
        [PermissionMode.AcceptEdits]: 'Accept Edits - Automatically accept file edit permissions for the session',
        [PermissionMode.Plan]: 'Plan - Claude can analyze but cannot modify files or execute commands',
        [PermissionMode.BypassPermissions]: 'Bypass Permissions - Skip all permission prompts (requires secure environment)'
      };

      const modeName = modeNames[mode];
      const finalMessage = abortMessage 
        ? `${abortMessage}✅ Permission mode changed to: \n**${modeName}**\n🔄 Claude session is resuming with the new permission mode.`
        : `✅ Permission mode changed to: \n**${modeName}**\nThe new permission mode is now active.`;

      await this.telegramSender.safeSendMessage(ctx.chat.id, finalMessage);
      
      // If we aborted a query, send a continue message to restart Claude session
      if (abortMessage) {
        this.claudeSDK.addMessageToStream(chatId, 'continue');
      }
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to change permission mode. Please try again.'), { parse_mode: 'MarkdownV2' });
      console.error('Error changing permission mode:', error);
    }
  }

  async handleModel(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    // Check if a model argument was provided
    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const modelArg = messageText.replace('/model', '').trim().toLowerCase();

    if (modelArg) {
      // Try to find matching model
      const matchedModel = AVAILABLE_MODELS.find(
        m => m.displayName.toLowerCase().includes(modelArg) ||
             m.value.toLowerCase().includes(modelArg)
      );

      if (matchedModel) {
        await this.handleModelChange(ctx, matchedModel.value);
        return;
      } else {
        await ctx.reply(this.formatter.formatError(`Unknown model: "${modelArg}". Use /model to see available options.`), { parse_mode: 'MarkdownV2' });
        return;
      }
    }

    // Show current model and selection keyboard
    const currentModel = AVAILABLE_MODELS.find(m => m.value === user.currentModel);
    const currentModelName = currentModel?.displayName || user.currentModel;

    const text = `🤖 Current model: **${currentModelName}**\n\nSelect a model:`;
    await this.telegramSender.safeSendMessage(chatId, text, KeyboardFactory.createModelSelectionKeyboard(user.currentModel));
  }

  async handleModelChange(ctx: Context, model: ClaudeModel): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    try {
      // Check if Claude is currently running and abort if needed
      let abortMessage = '';
      if (this.claudeSDK.isQueryRunning(chatId)) {
        const abortSuccess = await this.claudeSDK.abortQuery(chatId);
        if (abortSuccess) {
          abortMessage = '🛑 Current query has been stopped.\n';
        }
      }

      // Update model without clearing session
      user.setModel(model);
      await this.storage.saveUserSession(user);

      const modelInfo = AVAILABLE_MODELS.find(m => m.value === model);
      const modelName = modelInfo?.displayName || model;

      const finalMessage = abortMessage
        ? `${abortMessage}✅ Model switched to **${modelName}**\n🔄 Continue your conversation with the new model.`
        : `✅ Model switched to **${modelName}**`;

      await this.telegramSender.safeSendMessage(chatId, finalMessage);
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to change model. Please try again.'), { parse_mode: 'MarkdownV2' });
      console.error('Error changing model:', error);
    }
  }

  async handleDiff(ctx: Context): Promise<void> {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;
    const user = await this.getOrCreateUser(chatId);

    if (!user.activeProject || !user.projectPath) {
      await ctx.reply(this.formatter.formatError('No active project. Select a project first with /listproject.'), { parse_mode: 'MarkdownV2' });
      return;
    }

    try {
      const diff = await this.runGitDiff(user.projectPath);
      if (!diff) {
        await ctx.reply('No changes detected in the working directory.');
        return;
      }

      // If Workers is enabled, use WebApp viewer
      if (this.config.workers.enabled && this.config.workers.endpoint) {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (this.config.workers.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.workers.apiKey}`;
          }

          const response = await fetch(`${this.config.workers.endpoint}/api/diff`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ content: diff, chatid: chatId.toString() })
          });

          if (response.ok) {
            const result = await response.json() as { id: string };
            const miniAppUrl = `${this.config.workers.endpoint}/diff?id=${result.id}`;
            const keyboard = Markup.inlineKeyboard([
              Markup.button.webApp('📊 View Diff', miniAppUrl)
            ]);
            await ctx.reply('📊 Git diff for current project:', keyboard);
            return;
          }
        } catch {
          // Workers failed, fall through to HTML file
        }
      }

      // Generate self-contained HTML file with diff
      const projectName = path.basename(user.projectPath);
      const html = this.generateDiffHtml(diff, projectName);
      const buffer = Buffer.from(html, 'utf-8');

      await ctx.replyWithDocument(
        Input.fromBuffer(buffer, `diff-${projectName}.html`),
        { caption: `📊 Git diff for *${projectName}* — open in browser to view`, parse_mode: 'Markdown' }
      );
    } catch (error) {
      await ctx.reply(this.formatter.formatError('Failed to generate diff. Is this a git repository?'), { parse_mode: 'MarkdownV2' });
      console.error('Error generating diff:', error);
    }
  }

  private diff2htmlCssCache: string | null = null;

  private getDiff2HtmlCss(): string {
    if (!this.diff2htmlCssCache) {
      try {
        const cssPath = require.resolve('diff2html/bundles/css/diff2html.min.css');
        this.diff2htmlCssCache = fs.readFileSync(cssPath, 'utf-8');
      } catch {
        this.diff2htmlCssCache = '';
      }
    }
    return this.diff2htmlCssCache;
  }

  private generateDiffHtml(diff: string, projectName: string): string {
    const safeProjectName = projectName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const css = this.getDiff2HtmlCss();

    // Pre-render diff HTML on server — no JS or external resources needed
    const renderedDiff = diff2htmlHtml(diff, {
      outputFormat: 'line-by-line',
      drawFileList: true,
      matching: 'lines',
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Diff — ${safeProjectName}</title>
  <style>${css}</style>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    .header { padding: 12px 16px; background: #1a1a2e; color: #eee; font-size: 14px; }
    .header strong { color: #64ffda; }
    @media (prefers-color-scheme: light) {
      .header { background: #f0f0f0; color: #333; }
      .header strong { color: #0066cc; }
    }
  </style>
</head>
<body>
  <div class="header">📊 Diff — <strong>${safeProjectName}</strong></div>
  ${renderedDiff}
</body>
</html>`;
  }

  private runGitDiff(projectPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      // Try git diff HEAD first (staged + unstaged vs last commit)
      execFile('git', ['diff', 'HEAD'], { cwd: projectPath, maxBuffer: 1024 * 512, timeout: 10000 }, (error, stdout) => {
        if (!error && stdout.trim()) {
          resolve(stdout);
          return;
        }
        // Fallback: git diff (unstaged only, works even with no commits)
        execFile('git', ['diff'], { cwd: projectPath, maxBuffer: 1024 * 512, timeout: 10000 }, (error2, stdout2) => {
          if (!error2 && stdout2.trim()) {
            resolve(stdout2);
            return;
          }
          // Fallback: git diff --cached (staged only)
          execFile('git', ['diff', '--cached'], { cwd: projectPath, maxBuffer: 1024 * 512, timeout: 10000 }, (error3, stdout3) => {
            resolve(stdout3?.trim() ? stdout3 : null);
          });
        });
      });
    });
  }

  async getOrCreateUser(chatId: number): Promise<UserSessionModel> {
    let user = await this.storage.getUserSession(chatId);
    if (!user) {
      user = new UserSessionModel(chatId);
      await this.storage.saveUserSession(user);
    }
    return user;
  }
}