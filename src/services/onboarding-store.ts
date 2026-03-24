import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const STORE_DIR = path.join(os.homedir(), '.clinkcode');
const STORE_FILE = path.join(STORE_DIR, 'onboarding.json');

interface OnboardingData {
  [chatId: string]: {
    completed: boolean;
    completedAt?: string;
  };
}

function readStore(): OnboardingData {
  try {
    if (fs.existsSync(STORE_FILE)) {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    }
  } catch {
    // Corrupted file, start fresh
  }
  return {};
}

function writeStore(data: OnboardingData): void {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Failed to write onboarding store:', error);
  }
}

export function isOnboardingCompleted(chatId: number): boolean {
  const data = readStore();
  return data[String(chatId)]?.completed === true;
}

export function markOnboardingCompleted(chatId: number): void {
  const data = readStore();
  data[String(chatId)] = {
    completed: true,
    completedAt: new Date().toISOString(),
  };
  writeStore(data);
}

export function resetOnboardingStatus(chatId: number): void {
  const data = readStore();
  delete data[String(chatId)];
  writeStore(data);
}
