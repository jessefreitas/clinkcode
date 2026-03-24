#!/usr/bin/env node

import * as p from '@clack/prompts';
import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

// ── Config ──

const CONFIG_DIR = join(homedir(), '.clinkcode');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const ENV_FILE = join(CONFIG_DIR, '.env');
const PID_FILE = join(CONFIG_DIR, 'gateway.pid');

interface CliConfig {
  token: string;
  agentProvider: 'claude' | 'codex';
  agentCliPath: string;
  workDir: string;
  storageType: 'memory' | 'redis';
  redisUrl: string;
  allowedUsers: number[];
  secretRequired: boolean;
  secretToken: string;
  workersEnabled: boolean;
  workersEndpoint: string;
  workersApiKey: string;
  asrEnabled: boolean;
  asrEndpoint: string;
}

const DEFAULTS: CliConfig = {
  token: '',
  agentProvider: 'claude',
  agentCliPath: 'claude',
  workDir: join(homedir(), 'clinkcode-projects'),
  storageType: 'memory',
  redisUrl: '',
  allowedUsers: [],
  secretRequired: false,
  secretToken: '',
  workersEnabled: false,
  workersEndpoint: '',
  workersApiKey: '',
  asrEnabled: false,
  asrEndpoint: 'http://localhost:8600',
};

function loadCliConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveCliConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  generateEnvFile(config);
}

function generateEnvFile(config: CliConfig): void {
  const lines = [
    `TG_BOT_TOKEN=${config.token}`,
    `AGENT_PROVIDER=${config.agentProvider}`,
    `AGENT_CLI_PATH=${config.agentCliPath}`,
    `WORK_DIR=${config.workDir}`,
    `STORAGE_TYPE=${config.storageType}`,
    `BOT_MODE=polling`,
  ];

  if (config.redisUrl) lines.push(`REDIS_URL=${config.redisUrl}`);
  if (config.allowedUsers.length > 0) lines.push(`SECURITY_WHITELIST=${config.allowedUsers.join(',')}`);
  if (config.secretRequired) {
    lines.push(`SECURITY_SECRET_REQUIRED=true`);
    lines.push(`SECURITY_SECRET_TOKEN=${config.secretToken}`);
  }
  if (config.workersEnabled) {
    lines.push(`WORKERS_ENABLED=true`);
    if (config.workersEndpoint) lines.push(`WORKERS_ENDPOINT=${config.workersEndpoint}`);
    if (config.workersApiKey) lines.push(`WORKERS_API_KEY=${config.workersApiKey}`);
  }
  if (config.asrEnabled) {
    lines.push(`ASR_ENABLED=true`);
    lines.push(`ASR_ENDPOINT=${config.asrEndpoint}`);
  }

  writeFileSync(ENV_FILE, lines.join('\n') + '\n');
}

// ── Styling ──

const accent = chalk.hex('#7C3AED');
const dim = chalk.dim;
const ccGradient = gradient(['#7C3AED', '#A78BFA', '#60A5FA']);

function showBanner(): void {
  const banner = figlet.textSync('CLINK CODE', {
    font: 'ANSI Shadow',
    horizontalLayout: 'fitted',
  });
  console.log('');
  console.log(ccGradient(banner));
  console.log(dim('  ─────────────────────────────────────────────────────────────'));
  console.log(`  ${accent('●')} ${chalk.bold.white('CLINK CODE')}  ${dim('— AI coding agent via Telegram')}`);
  console.log(dim('  ─────────────────────────────────────────────────────────────'));
}

function maskToken(token: string): string {
  if (!token) return chalk.red('not configured');
  return chalk.green(token.slice(0, 6) + '...' + token.slice(-4));
}

function statusBar(config: CliConfig): void {
  const gw = getGatewayStatus();
  const gwStatus = gw.running
    ? chalk.green(`● running`) + dim(` (pid ${gw.pid})`)
    : chalk.red('○ stopped');

  const lines = [
    '',
    `  ${dim('Gateway'.padEnd(16))} ${gwStatus}`,
    `  ${dim('Token'.padEnd(16))} ${maskToken(config.token)}`,
    `  ${dim('Provider'.padEnd(16))} ${chalk.white(config.agentProvider)}`,
    `  ${dim('Agent CLI'.padEnd(16))} ${accent(config.agentCliPath)}`,
    `  ${dim('Work dir'.padEnd(16))} ${chalk.blue(config.workDir)}`,
    `  ${dim('Storage'.padEnd(16))} ${chalk.white(config.storageType)}`,
    `  ${dim('Allowed users'.padEnd(16))} ${config.allowedUsers.length > 0 ? chalk.white(config.allowedUsers.join(', ')) : dim('all')}`,
    `  ${dim('Workers'.padEnd(16))} ${config.workersEnabled ? chalk.green('enabled') : dim('disabled')}`,
    `  ${dim('ASR'.padEnd(16))} ${config.asrEnabled ? chalk.green('enabled') : dim('disabled')}`,
    '',
  ];
  console.log(lines.join('\n'));
}

// ── PID helpers ──

function savePid(pid: number): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid));
}

function readPid(): number | null {
  try {
    return parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

function clearPid(): void {
  try { unlinkSync(PID_FILE); } catch {}
}

function isRunning(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getGatewayStatus(): { running: boolean; pid: number | null } {
  const pid = readPid();
  if (pid && isRunning(pid)) return { running: true, pid };
  if (pid) clearPid();
  return { running: false, pid: null };
}

// ── Agent CLI Detection ──

function detectAgentCliPaths(): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  const seen = new Set<string>();

  const tryPath = (p: string, source: string) => {
    if (!seen.has(p) && existsSync(p)) {
      seen.add(p);
      found.push({ path: p, source });
    }
  };

  // Check common locations
  tryPath(join(homedir(), '.local', 'bin', 'claude'), '~/.local/bin');
  tryPath('/usr/local/bin/claude', '/usr/local/bin');
  tryPath(join(homedir(), '.claude', 'local', 'claude'), '~/.claude/local');
  tryPath(join(homedir(), '.npm-global', 'bin', 'claude'), 'npm global');

  // Check PATH via which
  try {
    const which = execSync('which claude 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (which && !seen.has(which)) {
      seen.add(which);
      found.push({ path: which, source: 'PATH' });
    }
  } catch {}

  return found;
}

// ── Wizard ──

async function runWizard(config: CliConfig): Promise<'start' | 'menu'> {
  console.clear();
  showBanner();

  p.intro(chalk.bold('Welcome! Let\'s set up Clink Code.'));

  // Disclaimer
  console.log('');
  p.log.warn(chalk.bold('Security — please read.'));
  console.log(`  ${dim('This bot can read files, run commands, and edit code')}`);
  console.log(`  ${dim('on behalf of anyone in the allowed users list.')}`);
  console.log(`  ${dim('A bad prompt can trick it into harmful actions.')}`);
  console.log('');
  console.log(`  ${dim('Recommended:')}`);
  console.log(`  ${dim('- Always configure an allowed users list')}`);
  console.log(`  ${dim('- Use approval mode for sensitive projects')}`);
  console.log(`  ${dim('- Do not expose the bot to untrusted users')}`);
  console.log('');

  const accepted = await p.confirm({
    message: 'I understand this is powerful and inherently risky. Continue?',
    initialValue: false,
  });
  if (p.isCancel(accepted) || !accepted) {
    p.outro(dim('Setup cancelled.'));
    process.exit(0);
  }

  // Step 1: Agent CLI
  console.log('');
  p.log.step(accent('Step 1/5') + dim(' — Agent CLI'));
  const detected = detectAgentCliPaths();

  if (detected.length > 0) {
    p.log.success(chalk.green('✓') + ` Found ${detected.length} installation(s)`);

    const cliOptions: Array<{ value: string; label: string; hint?: string }> = detected.map(d => ({
      value: d.path,
      label: d.path,
      hint: d.source,
    }));
    cliOptions.push({ value: '__manual__', label: '✏️  Enter path manually' });

    const choice = await p.select({
      message: 'Select Agent CLI to use',
      options: cliOptions,
      initialValue: detected[0]!.path,
    });

    if (p.isCancel(choice)) { p.outro(dim('Setup cancelled.')); process.exit(0); }

    if (choice === '__manual__') {
      const manualPath = await p.text({
        message: 'Full path to Agent CLI binary',
        placeholder: '/usr/local/bin/claude',
      });
      if (p.isCancel(manualPath)) { p.outro(dim('Setup cancelled.')); process.exit(0); }
      config.agentCliPath = (manualPath as string).trim();
    } else {
      config.agentCliPath = choice as string;
    }
  } else {
    p.log.warn('Agent CLI not found automatically.');
    const manualPath = await p.text({
      message: 'Enter the full path to Agent CLI binary',
      placeholder: '/usr/local/bin/claude',
      initialValue: config.agentCliPath || 'claude',
    });
    if (p.isCancel(manualPath)) { p.outro(dim('Setup cancelled.')); process.exit(0); }
    config.agentCliPath = (manualPath as string).trim();
  }

  p.log.success(`Using ${accent(config.agentCliPath)}`);
  saveCliConfig(config);

  // Step 2: Telegram Token
  console.log('');
  p.log.step(accent('Step 2/5') + dim(' — Telegram Bot Token'));
  p.log.message(dim('1. Open Telegram and search for @BotFather'));
  p.log.message(dim('2. Send /newbot and follow the instructions'));
  p.log.message(dim('3. Copy the token and paste it here'));

  const token = await p.text({
    message: 'Telegram bot token',
    placeholder: 'Paste the token from @BotFather',
    initialValue: config.token || '',
    validate: (v) => {
      if (!v || !v.trim()) return 'Token is required';
      if (!v.includes(':')) return 'Invalid token — expected format: 123456:ABC-DEF';
      return undefined;
    },
  });
  if (p.isCancel(token)) { p.outro(dim('Setup cancelled.')); process.exit(0); }
  config.token = (token as string).trim();
  saveCliConfig(config);
  p.log.success('Token saved!');

  // Step 3: Allowed Users
  console.log('');
  p.log.step(accent('Step 3/5') + dim(' — Allowed Users'));
  p.log.message(dim('Add your Telegram user ID for security.'));
  p.log.message(dim('Don\'t know your ID? Send /start to @userinfobot on Telegram.'));

  const userAction = await p.select({
    message: 'Manage allowed users',
    options: [
      { value: 'add', label: 'Add user ID' },
      { value: 'skip', label: 'Skip (allow anyone)' },
    ],
  });

  if (!p.isCancel(userAction) && userAction === 'add') {
    const userId = await p.text({
      message: 'Telegram user ID',
      placeholder: 'e.g. 123456789',
      validate: (v) => {
        if (!v || !v.trim() || isNaN(Number(v.trim()))) return 'Must be a number';
        return undefined;
      },
    });
    if (!p.isCancel(userId)) {
      const id = Number((userId as string).trim());
      if (!config.allowedUsers.includes(id)) {
        config.allowedUsers.push(id);
        saveCliConfig(config);
        p.log.success(`User ${accent(String(id))} added!`);
      }
    }
  }

  // Step 4: Working Directory
  console.log('');
  p.log.step(accent('Step 4/5') + dim(' — Working Directory'));
  p.log.message(dim('Where should cloned GitHub projects be stored?'));

  const workDir = await p.text({
    message: 'Working directory',
    placeholder: config.workDir,
    initialValue: config.workDir,
    validate: (v) => {
      if (!v || !v.trim()) return 'Path is required';
      return undefined;
    },
  });
  if (!p.isCancel(workDir)) {
    config.workDir = (workDir as string).trim();
    saveCliConfig(config);
    p.log.success('Working directory saved!');
  }

  // Step 5: Storage
  console.log('');
  p.log.step(accent('Step 5/5') + dim(' — Storage'));

  const storage = await p.select({
    message: 'Storage type',
    options: [
      { value: 'memory', label: 'Memory + File', hint: 'Simple, persists to JSON files' },
      { value: 'redis', label: 'Redis', hint: 'Production, requires Redis server' },
    ],
    initialValue: config.storageType,
  });

  if (!p.isCancel(storage)) {
    config.storageType = storage as 'memory' | 'redis';
    if (storage === 'redis') {
      const redisUrl = await p.text({
        message: 'Redis URL',
        placeholder: 'redis://localhost:6379',
        initialValue: config.redisUrl || 'redis://localhost:6379',
      });
      if (!p.isCancel(redisUrl)) {
        config.redisUrl = (redisUrl as string).trim();
      }
    }
    saveCliConfig(config);
    p.log.success('Storage configured!');
  }

  // Done
  console.log('');
  console.log(dim('  ─────────────────────────────────────────────────────────────'));
  p.log.success(chalk.bold('You\'re all set!'));
  p.log.message(dim('Configuration saved to ' + CONFIG_FILE));
  p.log.message(dim('Environment file saved to ' + ENV_FILE));
  console.log(dim('  ─────────────────────────────────────────────────────────────'));

  const startNow = await p.confirm({
    message: 'Start gateway now?',
  });

  if (!p.isCancel(startNow) && startNow) return 'start';
  return 'menu';
}

// ── Menu Handlers ──

async function handleToken(config: CliConfig): Promise<void> {
  const token = await p.text({
    message: 'Telegram bot token',
    placeholder: 'Paste the token from @BotFather',
    initialValue: config.token || '',
    validate: (v) => {
      if (!v || !v.trim()) return 'Token is required';
      if (!v.includes(':')) return 'Invalid token format';
      return undefined;
    },
  });
  if (p.isCancel(token)) return mainMenu();
  config.token = (token as string).trim();
  saveCliConfig(config);
  p.log.success('Token saved!');
  return mainMenu();
}

async function handleAgentCliPath(config: CliConfig): Promise<void> {
  const detected = detectAgentCliPaths();

  const options: Array<{ value: string; label: string; hint?: string }> = [];

  for (const d of detected) {
    const isCurrent = d.path === config.agentCliPath;
    options.push({
      value: d.path,
      label: `${isCurrent ? chalk.green('●') : '○'} ${d.path}`,
      hint: isCurrent ? `current — ${d.source}` : d.source,
    });
  }

  options.push({ value: '__manual__', label: '✏️  Enter path manually' });
  options.push({ value: '__back__', label: '← Back' });

  if (detected.length > 0) {
    p.log.info(`Found ${detected.length} Agent CLI installation(s)`);
  } else {
    p.log.warn('No Agent CLI found automatically.');
  }

  const choice = await p.select({
    message: 'Select Agent CLI',
    options,
  });

  if (p.isCancel(choice) || choice === '__back__') return mainMenu();

  if (choice === '__manual__') {
    const manualPath = await p.text({
      message: 'Full path to Agent CLI binary',
      placeholder: '/usr/local/bin/claude',
      initialValue: config.agentCliPath,
    });
    if (p.isCancel(manualPath)) return mainMenu();
    config.agentCliPath = (manualPath as string).trim();
  } else {
    config.agentCliPath = choice as string;
  }

  saveCliConfig(config);
  p.log.success(`Agent CLI set to ${accent(config.agentCliPath)}`);
  return mainMenu();
}

async function handleProvider(config: CliConfig): Promise<void> {
  const provider = await p.select({
    message: 'Select agent provider',
    options: [
      { value: 'claude', label: 'Claude' },
      { value: 'codex', label: 'Codex' },
      { value: '__back__', label: '← Back' },
    ],
    initialValue: config.agentProvider,
  });

  if (p.isCancel(provider) || provider === '__back__') return mainMenu();

  config.agentProvider = provider as 'claude' | 'codex';
  saveCliConfig(config);
  p.log.success(`Provider set to ${accent(config.agentProvider)}`);
  return mainMenu();
}

async function handleWorkDir(config: CliConfig): Promise<void> {
  const workDir = await p.text({
    message: 'Working directory for projects',
    initialValue: config.workDir,
    validate: (v) => { if (!v?.trim()) return 'Required'; return undefined; },
  });
  if (p.isCancel(workDir)) return mainMenu();
  config.workDir = (workDir as string).trim();
  saveCliConfig(config);
  p.log.success('Working directory saved!');
  return mainMenu();
}

async function handleUsers(config: CliConfig): Promise<void> {
  const action = await p.select({
    message: 'Manage allowed users',
    options: [
      { value: 'add', label: 'Add user' },
      { value: 'remove', label: 'Remove user' },
      { value: 'clear', label: 'Clear all (allow anyone)' },
      { value: 'back', label: '← Back' },
    ],
  });
  if (p.isCancel(action) || action === 'back') return mainMenu();

  if (action === 'add') {
    const userId = await p.text({
      message: 'Telegram user ID',
      placeholder: 'e.g. 123456789',
      validate: (v) => {
        if (!v?.trim() || isNaN(Number(v.trim()))) return 'Must be a number';
        return undefined;
      },
    });
    if (!p.isCancel(userId)) {
      const id = Number((userId as string).trim());
      if (!config.allowedUsers.includes(id)) {
        config.allowedUsers.push(id);
        saveCliConfig(config);
        p.log.success(`User ${id} added!`);
      } else {
        p.log.warn('User already in list.');
      }
    }
  } else if (action === 'remove') {
    if (config.allowedUsers.length === 0) {
      p.log.warn('No users to remove.');
    } else {
      const userId = await p.select({
        message: 'Remove user',
        options: config.allowedUsers.map(id => ({ value: String(id), label: String(id) })),
      });
      if (!p.isCancel(userId)) {
        config.allowedUsers = config.allowedUsers.filter(id => id !== Number(userId));
        saveCliConfig(config);
        p.log.success(`User ${userId} removed!`);
      }
    }
  } else if (action === 'clear') {
    config.allowedUsers = [];
    saveCliConfig(config);
    p.log.success('Allowlist cleared — anyone can use the bot.');
  }
  return mainMenu();
}

async function handleWorkers(config: CliConfig): Promise<void> {
  const enabled = await p.confirm({
    message: 'Enable Cloudflare Workers (for diff viewer)?',
    initialValue: config.workersEnabled,
  });
  if (p.isCancel(enabled)) return mainMenu();
  config.workersEnabled = enabled;

  if (enabled) {
    const endpoint = await p.text({
      message: 'Workers endpoint URL',
      initialValue: config.workersEndpoint || '',
      placeholder: 'https://your-worker.workers.dev',
    });
    if (!p.isCancel(endpoint)) config.workersEndpoint = (endpoint as string).trim();

    const apiKey = await p.text({
      message: 'Workers API key',
      initialValue: config.workersApiKey || '',
      placeholder: 'your-api-key',
    });
    if (!p.isCancel(apiKey)) config.workersApiKey = (apiKey as string).trim();
  }

  saveCliConfig(config);
  p.log.success('Workers configuration saved!');
  return mainMenu();
}

async function handleAsr(config: CliConfig): Promise<void> {
  const enabled = await p.confirm({
    message: 'Enable ASR (voice message transcription)?',
    initialValue: config.asrEnabled,
  });
  if (p.isCancel(enabled)) return mainMenu();
  config.asrEnabled = enabled;

  if (enabled) {
    const endpoint = await p.text({
      message: 'ASR endpoint URL',
      initialValue: config.asrEndpoint || 'http://localhost:8600',
    });
    if (!p.isCancel(endpoint)) config.asrEndpoint = (endpoint as string).trim();
  }

  saveCliConfig(config);
  p.log.success('ASR configuration saved!');
  return mainMenu();
}

function startGateway(): void {
  const gw = getGatewayStatus();
  if (gw.running) {
    p.log.warn(`Gateway is already running (pid ${gw.pid}).`);
    return;
  }

  const config = loadCliConfig();
  if (!config.token) {
    p.log.error('No token configured. Run setup first.');
    return;
  }

  // Always regenerate .env before starting
  generateEnvFile(config);

  // Build env vars from CLI config — these override any .env files
  const envVars: Record<string, string> = {
    ...process.env as Record<string, string>,
    TG_BOT_TOKEN: config.token,
    AGENT_PROVIDER: config.agentProvider,
    AGENT_CLI_PATH: config.agentCliPath,
    WORK_DIR: config.workDir,
    STORAGE_TYPE: config.storageType,
    BOT_MODE: 'polling',
  };

  if (config.redisUrl) envVars.REDIS_URL = config.redisUrl;
  if (config.allowedUsers.length > 0) envVars.SECURITY_WHITELIST = config.allowedUsers.join(',');
  if (config.secretRequired) {
    envVars.SECURITY_SECRET_REQUIRED = 'true';
    envVars.SECURITY_SECRET_TOKEN = config.secretToken;
  }
  if (config.workersEnabled) {
    envVars.WORKERS_ENABLED = 'true';
    if (config.workersEndpoint) envVars.WORKERS_ENDPOINT = config.workersEndpoint;
    if (config.workersApiKey) envVars.WORKERS_API_KEY = config.workersApiKey;
  }
  if (config.asrEnabled) {
    envVars.ASR_ENABLED = 'true';
    envVars.ASR_ENDPOINT = config.asrEndpoint;
  }

  // Log file for debugging
  const logPath = join(CONFIG_DIR, 'gateway.log');
  const logFd = require('fs').openSync(logPath, 'a');

  const { spawn } = require('child_process');
  const child = spawn('node', [join(__dirname, 'main.js')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: envVars,
    cwd: process.cwd(),
  });

  child.unref();
  savePid(child.pid);
  p.log.success(chalk.green(`Gateway started (pid ${child.pid})`));
  p.log.message(dim(`Logs: ${logPath}`));
}

function stopGateway(): void {
  const gw = getGatewayStatus();
  if (!gw.running || !gw.pid) {
    p.log.warn('Gateway is not running.');
    return;
  }

  try {
    process.kill(gw.pid, 'SIGTERM');
    clearPid();
    p.log.success('Gateway stopped.');
  } catch {
    p.log.error('Failed to stop gateway.');
  }
}

// ── Main Menu ──

async function mainMenu(): Promise<void> {
  const config = loadCliConfig();

  console.clear();
  showBanner();
  statusBar(config);

  const gw = getGatewayStatus();

  const options: Array<{ value: string; label: string; hint?: string }> = [];

  if (gw.running) {
    options.push({ value: 'stop', label: `${chalk.red('■')} Stop gateway`, hint: `pid ${gw.pid}` });
    options.push({ value: 'restart', label: `${chalk.yellow('↻')} Restart gateway` });
  } else {
    if (config.token) {
      options.push({ value: 'start', label: `${chalk.green('▶')} Start gateway` });
    } else {
      options.push({ value: 'setup', label: `${chalk.green('▶')} Setup wizard`, hint: 'configure to get started' });
    }
  }

  options.push(
    { value: 'token', label: 'Telegram token' },
    { value: 'provider', label: 'Agent provider' },
    { value: 'agentcli', label: 'Agent CLI path' },
    { value: 'workdir', label: 'Working directory' },
    { value: 'users', label: 'Allowed users' },
    { value: 'workers', label: 'Workers (diff viewer)' },
    { value: 'asr', label: 'ASR (voice messages)' },
    { value: 'setup', label: 'Run setup wizard' },
    { value: 'exit', label: `${chalk.red('✕')} Exit` },
  );

  const action = await p.select({
    message: 'What would you like to do?',
    options,
  });

  if (p.isCancel(action) || action === 'exit') {
    p.outro(dim('Goodbye!'));
    process.exit(0);
  }

  switch (action) {
    case 'start':
      startGateway();
      await pause();
      return mainMenu();
    case 'stop':
      stopGateway();
      await pause();
      return mainMenu();
    case 'restart':
      stopGateway();
      await new Promise(r => setTimeout(r, 1000));
      startGateway();
      await pause();
      return mainMenu();
    case 'setup':
      const result = await runWizard(config);
      if (result === 'start') {
        startGateway();
        await pause();
      }
      return mainMenu();
    case 'token':
      return handleToken(config);
    case 'provider':
      return handleProvider(config);
    case 'agentcli':
      return handleAgentCliPath(config);
    case 'workdir':
      return handleWorkDir(config);
    case 'users':
      return handleUsers(config);
    case 'workers':
      return handleWorkers(config);
    case 'asr':
      return handleAsr(config);
  }
}

async function pause(): Promise<void> {
  await new Promise(r => setTimeout(r, 1500));
}

// ── Entry Point ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'setup' || cmd === 'onboard') {
    const config = loadCliConfig();
    const result = await runWizard(config);
    if (result === 'start') startGateway();
    return;
  }

  if (cmd === 'start' || cmd === 'gateway') {
    startGateway();
    return;
  }

  if (cmd === 'stop') {
    stopGateway();
    return;
  }

  if (cmd === 'status') {
    const gw = getGatewayStatus();
    console.log(gw.running ? `Gateway running (pid ${gw.pid})` : 'Gateway stopped');
    return;
  }

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(`
${chalk.bold('Clink Code')} — AI coding agent via Telegram

${chalk.bold('Usage:')}
  clinkcode                  Interactive menu
  clinkcode setup            Run setup wizard
  clinkcode start            Start the gateway
  clinkcode stop             Stop the gateway
  clinkcode status           Show gateway status
  clinkcode provider <name>  Set provider (claude|codex)
  clinkcode help             Show this help
`);
    return;
  }

  if (cmd === 'provider') {
    const value = (args[1] || '').toLowerCase();
    if (value !== 'claude' && value !== 'codex') {
      console.error('Usage: clinkcode provider <claude|codex>');
      process.exit(1);
    }
    const config = loadCliConfig();
    config.agentProvider = value as 'claude' | 'codex';
    saveCliConfig(config);
    console.log(`Provider set to ${config.agentProvider}`);
    return;
  }

  // No args or unknown: check if first run
  const config = loadCliConfig();
  if (!config.token) {
    const result = await runWizard(config);
    if (result === 'start') {
      startGateway();
      await pause();
    }
  }

  return mainMenu();
}

main().catch(console.error);
