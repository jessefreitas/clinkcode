export enum UserState {
  Idle = 'idle',
  WaitingProjectType = 'waiting_project_type',
  WaitingRepo = 'waiting_repo',
  WaitingDirectory = 'waiting_directory',
  InSession = 'in_session',
  WaitingASREdit = 'waiting_asr_edit',
  WaitingPickerSearch = 'waiting_picker_search',
  // Onboarding states
  OnboardingWelcome = 'onboarding_welcome',
  OnboardingDisclaimer = 'onboarding_disclaimer',
  OnboardingModel = 'onboarding_model',
  OnboardingProject = 'onboarding_project',
}

export type AgentProvider = 'claude' | 'codex';

export enum ProjectType {
  GitHub = 'github',
  Directory = 'directory',
}

export enum TargetTool {
  Task = 'Task',
  Bash = 'Bash',
  Glob = 'Glob',
  Grep = 'Grep',
  LS = 'LS',
  ExitPlanMode = 'ExitPlanMode',
  Read = 'Read',
  Edit = 'Edit',
  MultiEdit = 'MultiEdit',
  Write = 'Write',
  TodoWrite = 'TodoWrite',
}

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  repoUrl?: string;
  localPath: string;
  created: Date;
  lastUsed: Date;
  status: string;
}

export interface User {
  chat_id: number;
  state: UserState;
  projects: Map<string, Project>;
  activeProject: string;
  currentInput: string;
  lastActivity: Date;
}


export interface RepoInfo {
  name: string;
  description: string;
  language: string;
  size: string;
  updatedAt: string;
  private: boolean;
  url: string;
}

export enum PermissionMode {
  Default = 'default',
  AcceptEdits = 'acceptEdits',
  Plan = 'plan',
  BypassPermissions = 'bypassPermissions'
}

export interface UserStats {
  totalUsers: number;
  activeUsers: number;
  totalProjects: number;
  activeSessions: number;
}

export interface DirectoryItem {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: Date;
  icon: string;
}

export interface FileBrowsingState {
  currentPath: string;
  basePath: string;
  currentPage: number;
  itemsPerPage: number;
  totalItems: number;
  items: DirectoryItem[];
  messageId?: number;
}

// Model types by provider
export type ClaudeModel =
  | 'claude-sonnet-4-5-20250929'
  | 'claude-opus-4-5-20251101'
  | 'claude-haiku-4-5-20251001';

export type CodexModel = string;

export type AgentModel = ClaudeModel | CodexModel;

export interface ModelInfo {
  value: AgentModel;
  provider: AgentProvider;
  displayName: string;
  description: string;
}

const CLAUDE_MODELS: ModelInfo[] = [
  { value: 'claude-sonnet-4-5-20250929', provider: 'claude', displayName: 'Sonnet 4.5', description: 'Balanced' },
  { value: 'claude-opus-4-5-20251101', provider: 'claude', displayName: 'Opus 4.5', description: 'Most capable' },
  { value: 'claude-haiku-4-5-20251001', provider: 'claude', displayName: 'Haiku 4.5', description: 'Fastest' },
];

export const DEFAULT_CODEX_MODELS: ModelInfo[] = [
  { value: 'gpt-5-codex', provider: 'codex', displayName: 'GPT-5 Codex', description: 'Coding optimized' },
  { value: 'gpt-5', provider: 'codex', displayName: 'GPT-5', description: 'Most capable' },
  { value: 'gpt-5-mini', provider: 'codex', displayName: 'GPT-5 Mini', description: 'Faster' },
];

let runtimeCodexModels: ModelInfo[] = [...DEFAULT_CODEX_MODELS];

export const AVAILABLE_MODELS: ModelInfo[] = [...CLAUDE_MODELS, ...DEFAULT_CODEX_MODELS];

export const DEFAULT_PROVIDER: AgentProvider = 'claude';

export const DEFAULT_MODELS: Record<AgentProvider, AgentModel> = {
  claude: 'claude-opus-4-5-20251101',
  codex: 'gpt-5-codex',
};

export const DEFAULT_MODEL: AgentModel = DEFAULT_MODELS[DEFAULT_PROVIDER];

export function setCodexModels(models: ModelInfo[]): void {
  const unique = new Map<string, ModelInfo>();
  for (const model of models) {
    if (model.provider !== 'codex') continue;
    if (!model.value || !model.displayName) continue;
    unique.set(model.value, model);
  }
  if (unique.size > 0) {
    runtimeCodexModels = Array.from(unique.values());
  }
}

export function getModelsForProvider(provider: AgentProvider): ModelInfo[] {
  return provider === 'codex' ? runtimeCodexModels : CLAUDE_MODELS;
}

export function getAllProviderModels(): ModelInfo[] {
  return [...CLAUDE_MODELS, ...runtimeCodexModels];
}

export function resolveModelForProvider(provider: AgentProvider, currentModel: AgentModel): AgentModel {
  const providerModels = getModelsForProvider(provider);
  const hasModel = providerModels.some((model) => model.value === currentModel);
  return hasModel ? currentModel : DEFAULT_MODELS[provider];
}
