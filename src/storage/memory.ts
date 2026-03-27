import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UserSessionModel } from '../models/user-session';
import { Project } from '../models/project';
import { IStorage } from './interface';

const STORE_DIR = path.join(os.homedir(), '.clinkcode');
const SESSIONS_FILE = path.join(STORE_DIR, 'sessions.json');
const PROJECTS_FILE = path.join(STORE_DIR, 'projects.json');

export class MemoryStorage implements IStorage {
  private userSessions: Map<number, UserSessionModel> = new Map();
  private userProjects: Map<number, Map<string, Project>> = new Map();
  private pendingASR: Map<number, string> = new Map();

  private toolUseStorage: Map<string, {
    name: string;
    messageId: number;
    originalMessage: string;
    chatId: string;
    createdAt: number;
  }> = new Map();

  async initialize(): Promise<void> {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    this.loadSessions();
    this.loadProjects();
    console.log('Memory storage initialized (with file persistence)');
  }

  async disconnect(): Promise<void> {
    this.persistSessions();
    this.persistProjects();
    this.userSessions.clear();
    this.userProjects.clear();
    this.toolUseStorage.clear();
    this.pendingASR.clear();
    console.log('Memory storage disconnected');
  }

  // --- User session methods ---

  async saveUserSession(userSession: UserSessionModel): Promise<void> {
    this.userSessions.set(userSession.chatId, userSession);
    this.persistSessions();
  }

  async getUserSession(chatId: number): Promise<UserSessionModel | null> {
    return this.userSessions.get(chatId) || null;
  }

  async deleteUserSession(chatId: number): Promise<void> {
    this.userSessions.delete(chatId);
    this.persistSessions();
  }

  async updateSessionActivity(userSession: UserSessionModel): Promise<void> {
    userSession.updateActivity();
    await this.saveUserSession(userSession);
  }

  async startAgentSession(userSession: UserSessionModel, sessionId: string, projectPath?: string): Promise<void> {
    userSession.startSession(sessionId, projectPath);
    await this.saveUserSession(userSession);
  }

  async endAgentSession(userSession: UserSessionModel): Promise<void> {
    userSession.endSession();
    await this.saveUserSession(userSession);
  }

  // --- Tool use methods (ephemeral, no persistence) ---

  private getToolUseKey(sessionId: string, toolId: string): string {
    return `tool_use_storage:${sessionId}_${toolId}`;
  }

  async storeToolUse(sessionId: string, toolId: string, toolData: {
    name: string;
    messageId: number;
    originalMessage: string;
    chatId: string;
  }): Promise<void> {
    const key = this.getToolUseKey(sessionId, toolId);
    const data = {
      ...toolData,
      createdAt: Date.now()
    };
    this.toolUseStorage.set(key, data);

    // Auto-cleanup after 30 minutes
    setTimeout(() => {
      this.toolUseStorage.delete(key);
    }, 30 * 60 * 1000);
  }

  async getToolUse(sessionId: string, toolId: string): Promise<{
    name: string;
    messageId: number;
    originalMessage: string;
    chatId: string;
    createdAt: number;
  } | null> {
    const key = this.getToolUseKey(sessionId, toolId);
    return this.toolUseStorage.get(key) || null;
  }

  async deleteToolUse(sessionId: string, toolId: string): Promise<void> {
    const key = this.getToolUseKey(sessionId, toolId);
    this.toolUseStorage.delete(key);
  }

  // --- Pending ASR methods (ephemeral, no persistence) ---

  async storePendingASR(chatId: number, text: string): Promise<void> {
    this.pendingASR.set(chatId, text);
    setTimeout(() => {
      this.pendingASR.delete(chatId);
    }, 5 * 60 * 1000);
  }

  async getPendingASR(chatId: number): Promise<string | null> {
    return this.pendingASR.get(chatId) || null;
  }

  async deletePendingASR(chatId: number): Promise<void> {
    this.pendingASR.delete(chatId);
  }

  // --- Project methods ---

  async getUserProjects(userId: number): Promise<Project[]> {
    const projectsMap = this.userProjects.get(userId);
    if (!projectsMap) {
      return [];
    }

    return Array.from(projectsMap.values())
      .sort((a, b) => b.lastAccessed.getTime() - a.lastAccessed.getTime());
  }

  async getProject(projectId: string, userId: number): Promise<Project | null> {
    const projectsMap = this.userProjects.get(userId);
    if (!projectsMap) {
      return null;
    }

    return projectsMap.get(projectId) || null;
  }

  async saveProject(project: Project): Promise<void> {
    if (!this.userProjects.has(project.userId)) {
      this.userProjects.set(project.userId, new Map());
    }

    this.userProjects.get(project.userId)!.set(project.id, { ...project });
    this.persistProjects();
  }

  async deleteProject(projectId: string, userId: number): Promise<void> {
    const projectsMap = this.userProjects.get(userId);
    if (projectsMap) {
      projectsMap.delete(projectId);
    }
    this.persistProjects();
  }

  async updateProjectLastAccessed(projectId: string, userId: number): Promise<void> {
    const project = await this.getProject(projectId, userId);
    if (project) {
      project.lastAccessed = new Date();
      await this.saveProject(project);
    }
  }

  // --- File persistence ---

  private persistSessions(): void {
    try {
      const data: Record<string, any> = {};
      for (const [chatId, session] of this.userSessions) {
        data[String(chatId)] = session.toJSON();
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to persist sessions:', error);
    }
  }

  private loadSessions(): void {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      for (const [chatId, sessionData] of Object.entries(raw)) {
        const session = UserSessionModel.fromJSON(sessionData);
        this.userSessions.set(Number(chatId), session);
      }
      console.log(`Loaded ${this.userSessions.size} user session(s) from disk`);
    } catch (error) {
      console.error('Failed to load sessions from disk:', error);
    }
  }

  private persistProjects(): void {
    try {
      const data: Record<string, Record<string, any>> = {};
      for (const [userId, projectsMap] of this.userProjects) {
        const userKey = String(userId);
        data[userKey] = {};
        for (const [projectId, project] of projectsMap) {
          data[userKey]![projectId] = {
            ...project,
            createdAt: project.createdAt instanceof Date ? project.createdAt.toISOString() : project.createdAt,
            lastAccessed: project.lastAccessed instanceof Date ? project.lastAccessed.toISOString() : project.lastAccessed,
          };
        }
      }
      fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to persist projects:', error);
    }
  }

  private loadProjects(): void {
    try {
      if (!fs.existsSync(PROJECTS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
      for (const [userId, projects] of Object.entries(raw)) {
        const projectsMap = new Map<string, Project>();
        for (const [projectId, projectData] of Object.entries(projects as Record<string, any>)) {
          projectsMap.set(projectId, {
            ...projectData,
            createdAt: new Date(projectData.createdAt),
            lastAccessed: new Date(projectData.lastAccessed),
          });
        }
        this.userProjects.set(Number(userId), projectsMap);
      }
      console.log(`Loaded projects for ${this.userProjects.size} user(s) from disk`);
    } catch (error) {
      console.error('Failed to load projects from disk:', error);
    }
  }
}
