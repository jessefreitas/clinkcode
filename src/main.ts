#!/usr/bin/env node
import { Telegraf } from 'telegraf';
import { loadConfig, validateConfig } from './config/config';
import { StorageFactory } from './storage/factory';
import { IStorage } from './storage/interface';
import { GitHubManager } from './handlers/github';
import { DirectoryManager } from './handlers/directory';
import { ClaudeManager } from './handlers/claude';
import { CodexManager } from './handlers/codex';
import { ProviderRouterManager } from './handlers/provider-router';
import { TelegramHandler } from './handlers/telegram';
import { ExpressServer } from './server/express';
import { MessageFormatter } from './utils/formatter';
import { PermissionManager } from './handlers/permission-manager';
import { IAgentManager } from './handlers/agent-manager';

async function main(): Promise<void> {
  try {
    // Load and validate configuration
    const config = loadConfig();
    validateConfig(config);

    console.log('Configuration loaded successfully');

    // Create Telegram Bot
    const bot = new Telegraf(config.telegram.botToken);
    bot.telegram.getMe().then((botInfo) => {
      console.log(`Authorized as @${botInfo.username}`);
    });

    // Initialize components
    const storage = StorageFactory.create(config.storage);
    await storage.initialize();
    console.log(`${config.storage.type} storage initialized`);
    
    const messageFormatter = new MessageFormatter();
    const github = new GitHubManager(config.workDir.workDir);
    const directory = new DirectoryManager();

    // Initialize Permission Manager
    const permissionManager = new PermissionManager(bot);
    console.log('Permission manager initialized');

    // First create a placeholder handler that we'll set up later
    let telegramHandler: TelegramHandler;

    // Initialize agent manager with callback architecture
    const callbacks = {
      onAgentResponse: async (userId: string, message: any, toolInfo?: { toolId: string; toolName: string; isToolUse: boolean; isToolResult: boolean }, parentToolUseId?: string) => {
        await telegramHandler.handleAgentResponse(userId, message, toolInfo, parentToolUseId);
      },
      onAgentError: async (userId: string, error: string) => {
        await telegramHandler.handleAgentError(userId, error);
      }
    };

    const codexOptions = {
      ...(config.codex.binaryPath ? { codexPathOverride: config.codex.binaryPath } : {}),
      ...(config.codex.apiKey ? { apiKey: config.codex.apiKey } : {}),
      ...(config.codex.baseUrl ? { baseUrl: config.codex.baseUrl } : {}),
    };

    const claudeManager = new ClaudeManager(storage, permissionManager, callbacks, config.agentCli.binaryPath);
    const codexManager = new CodexManager(storage, callbacks, {
      ...codexOptions,
    });

    const agentManager: IAgentManager = new ProviderRouterManager(config.agent.provider, {
      claude: claudeManager,
      codex: codexManager,
    });

    console.log(`Agent manager initialized with provider: ${agentManager.provider}`);

    // Create Telegram handler with callback architecture
    telegramHandler = new TelegramHandler(
      bot,
      github,
      directory,
      agentManager,
      storage,
      messageFormatter,
      config,
      permissionManager
    );

    console.log('Telegram handler initialized with callback architecture');
    
    if (config.telegram.mode === 'webhook') {
      if (!config.webhook) {
        throw new Error('Webhook configuration is missing');
      }
      const expressServer = new ExpressServer(bot, 3001);
      // Set up webhook
      await expressServer.setupWebhook(config.webhook);
      // Start Express server
      expressServer.setupRoutes();
      await expressServer.start();
    }
    
    // Start bot based on mode
    console.log(`Starting Telegram bot in ${config.telegram.mode} mode...`);
    
    // Register bot commands menu
    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Start Clink Code' },
      { command: 'createproject', description: 'Create a new project' },
      { command: 'listproject', description: 'Browse existing projects' },
      { command: 'exitproject', description: 'Exit current project' },
      { command: 'model', description: 'Change model' },
      { command: 'resume', description: 'Resume a previous session' },
      { command: 'clear', description: 'Clear current session' },
      { command: 'abort', description: 'Abort current query' },
      { command: 'status', description: 'Show current status' },
      { command: 'diff', description: 'View git diff of current project' },
      { command: 'ls', description: 'Browse project files' },
      { command: 'default', description: 'Standard permission mode' },
      { command: 'acceptedits', description: 'Auto-accept file edits' },
      { command: 'plan', description: 'Analysis only, no modifications' },
      { command: 'bypass', description: 'Skip all permission prompts' },
      { command: 'auth', description: 'Authenticate with secret token' },
      { command: 'resetonboarding', description: 'Redo the setup wizard' },
      { command: 'help', description: 'Show help' },
    ]);
    console.log('Bot commands menu registered');

    if (config.telegram.mode === 'webhook') {
      console.log('Telegram bot is running in webhook mode');
    } else {
      // Use polling mode (default)
      await bot.launch();
      console.log('Telegram bot is running in polling mode');
    }

    // Check ASR service availability
    if (config.asr.enabled) {
      try {
        const asrHealth = await fetch(`${config.asr.endpoint}/health`);
        if (asrHealth.ok) {
          console.log(`ASR service is available at ${config.asr.endpoint}`);
        } else {
          console.warn(`ASR service returned status ${asrHealth.status}. Voice messages may not work.`);
        }
      } catch {
        console.warn(`ASR service is not reachable at ${config.asr.endpoint}. Start it with: pnpm run asr`);
      }
    }

    // Handle graceful shutdown (register after successful startup)
    process.once('SIGINT', () => gracefulShutdown(bot, agentManager, storage));
    process.once('SIGTERM', () => gracefulShutdown(bot, agentManager, storage));
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}


async function gracefulShutdown(
  bot: Telegraf,
  agentManager: IAgentManager,
  storage: IStorage
): Promise<void> {
  console.log('Received shutdown signal, shutting down gracefully...');

  try {
    // Stop the bot
    bot.stop('SIGINT');

    // Shutdown agent manager
    await agentManager.shutdown();

    // Disconnect storage
    await storage.disconnect();
    console.log('Storage disconnected');
    
    console.log('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
