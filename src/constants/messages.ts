// Text templates for Telegram bot messages
export const MESSAGES = {
  // Welcome message
  WELCOME_TEXT: `🚀 Welcome to AI coding agent Bot!

This bot helps you interact with AI coding agent through Telegram.

Main features:
• Create and manage multiple projects
• Connect with GitHub repositories
• Use AI coding agent in Telegram
• Full keyboard interaction support

Available commands:
📋 **Project Management**
• /createproject - Create new project
• /listproject - View all projects  
• /exitproject - Exit current project

💬 **Session Control**
• /auth - Authenticate with secret (if required)
• /abort - Abort current query
• /clear - Clear session
• /resume - Resume a previous AI coding agent session

🔧 **Permission Modes**
• /default - Standard behavior with permission prompts
• /acceptedits - Auto-accept file edit permissions
• /plan - Analysis only, no modifications
• /bypass - Skip all permission prompts

📁 **File Operations**
• /ls - Browse project files

ℹ️ **Information**
• /status - View current status
• /help - Show detailed help

Let's get started! 🎉`,

  // Project creation
  CREATE_PROJECT_TEXT: `📁 Create New Project

Please select project type:

🔗 **GitHub Repository**
- Clone repository from GitHub
- Support public and private repos
- Auto-download code locally

📂 **Local Directory**
- Use existing local directory
- Support any absolute path
- Start directly in specified directory`,

  // GitHub project setup
  GITHUB_PROJECT_TEXT: `🔗 GitHub Repository Project

Please send GitHub repository link in format:
• https://github.com/username/repo
• git@github.com:username/repo.git

Supported repository types:
✅ Public repositories

Example:
https://github.com/microsoft/vscode`,

  // Local directory project setup
  LOCAL_PROJECT_TEXT: `📂 Local Directory Project

Please send absolute path of local directory, for example:
• /Users/username/projects/myproject
• /home/user/code/myapp
• /opt/projects/webapp

Requirements:
✅ Must be absolute path (starting with /)
✅ Directory must exist and accessible
✅ Have read/write permissions

Example:
/Users/john/projects/my-react-app`,

  // Project confirmation
  PROJECT_CONFIRMATION_TEXT: (name: string, description: string, language: string, size: string, updatedAt: string) => 
    `📋 Project Information Confirmation

Repository: ${name}
Description: ${description}
Language: ${language}
Size: ${size}
Last updated: ${updatedAt}

Using repository name "${name}" as project name...`,

  // Directory confirmation
  DIRECTORY_CONFIRMATION_TEXT: (name: string, path: string, files: number, directories: number, lastModified: string) =>
    `📋 Directory Information Confirmation

Directory name: ${name}
Path: ${path}
File count: ${files}
Subdirectory count: ${directories}
Last modified: ${lastModified}

Using directory name "${name}" as project name...`,

  // Success messages
  PROJECT_SUCCESS_TEXT: (name: string, projectId: string, repoUrl?: string, localPath?: string, sourcePath?: string) => {
    const repoSection = repoUrl ? `Repository URL: ${repoUrl}\n` : '';
    const sourceSection = sourcePath ? `Source path: ${sourcePath}\n` : '';
    
    return `✅ Project created successfully!

Project name: ${name}
Project ID: ${projectId}
${repoSection}Project type: ${repoUrl ? 'GitHub repository' : 'Local directory'}
Local path: ${localPath}
${sourceSection}
Project is ready! You can now chat with the AI coding agent directly.`;
  },

  // Status messages
  STATUS_TEXT: (userState: string, sessionStatus: string, projectCount: number, activeProjectName: string, activeProjectType: string, activeProjectPath: string, permissionMode: string, authStatus: string, hasAgentSession: string) =>
    `📊 Current Status

🔧 **System Status**
User state: ${userState}
Session status: ${sessionStatus}
Authentication: ${authStatus}
Agent session: ${hasAgentSession}

📋 **Projects**
Total projects: ${projectCount}
Active project: ${activeProjectName}
Project type: ${activeProjectType}
Project path: ${activeProjectPath}

⚙️ **Settings**
Permission mode: ${permissionMode}`,

  // Help text
  HELP_TEXT: `📚 *Clink Code — Help*

📋 *Projects*
/listproject — Browse and create projects
/createproject — Create a new project
/exitproject — Exit current project

💬 *Session*
/resume — Resume a previous session
/clear — Clear current session
/abort — Abort current query
/diff — View git diff of current project

🔧 *Permission Modes*
/default — Standard with permission prompts
/acceptedits — Auto-accept file edits
/plan — Analysis only, no modifications
/bypass — Skip all permission prompts

📁 *Tools*
/ls — Browse project files
/model — Change model
/status — View current status

🔐 *Security*
/auth — Authenticate with secret token

*Getting Started:*
1. Select a project with /listproject
2. Send messages to chat with the AI coding agent
3. Use /diff to review changes`,

  // Progress messages
  CLONING_REPO: '⏳ Cloning repository...',
  TYPING_INDICATOR: '⌨️ Typing...',

  // Error messages
  ERRORS: {
    COMPLETE_CURRENT_OPERATION: 'Please exit current project first',
    INVALID_GITHUB_URL: 'Invalid GitHub repository link',
    INVALID_ABSOLUTE_PATH: 'Please provide absolute path (starting with /)',
    DIRECTORY_NOT_FOUND: 'Directory does not exist or cannot be accessed',
    PROJECT_CREATION_FAILED: (error: string) => `Project creation failed: ${error}`,
    NO_ACTIVE_SESSION: 'No active session',
    SEND_INPUT_FAILED: (error: string) => `Failed to send input: ${error}`,
    INVALID_OPERATION: 'Invalid operation',
    USER_NOT_INITIALIZED: 'User not initialized',
    FEATURE_IN_DEVELOPMENT: 'Feature under development'
  },

  // Permission messages
  PERMISSION_GRANTED: 'Permission granted',
  PERMISSION_DENIED: 'Permission denied',

  // Button labels
  BUTTONS: {
    GITHUB_REPO: '🔗 GitHub Repository',
    LOCAL_DIRECTORY: '📂 Local Directory',
    CANCEL: '❌ Cancel',
    START_SESSION: '🚀 Start Session',
    PROJECT_LIST: '📋 Project List',
    APPROVE: '✅ Allow',
    DENY: '❌ Deny',
  },

  // Onboarding messages
  ONBOARDING: {
    WELCOME: `🚀 *Welcome to Clink Code!*

Clink Code is your Telegram gateway to AI coding agent — powerful AI-assisted coding directly from Telegram.

*What you can do:*
• Create projects from GitHub repos or local directories
• Chat with the AI coding agent to analyze, edit, and create code
• Use voice messages and images as input
• Manage multiple projects and sessions

Let's get you set up!`,

    DISCLAIMER: `⚠️ *Security Disclaimer*

Before using Clink Code, please understand:

• AI coding agent can *read, edit, and execute* code in your projects
• Always *review changes* before approving them
• Use *permission modes* to control the agent's capabilities
• Never share sensitive credentials in conversations
• You are responsible for all code changes made

By continuing, you acknowledge and accept these terms.`,

    MODEL_SELECTION: `🤖 *Choose Your Default Model*

Select the model you'd like to use:

*Opus 4.5* — Most capable, best for complex tasks
*Sonnet 4.5* — Balanced performance and speed
*Haiku 4.5* — Fastest, best for simple tasks

You can change this anytime with /model.`,

    PROJECT_GUIDE: `📁 *Create Your First Project*

Would you like to set up your first project now?

*GitHub Repository* — Clone and work with a repo
*Local Directory* — Use an existing directory

Or skip and create a project later with /createproject.`,

    COMPLETED: `✅ *Setup Complete!*

You're ready to use Clink Code.

*Quick Start:*
• /createproject — Create a new project
• /listproject — Browse existing projects
• /model — Change model
• /help — View all commands

Start by creating or selecting a project!`,

    DECLINE_WARNING: `⚠️ You must accept the disclaimer to use Clink Code.

The disclaimer ensures you understand the security implications of using AI-assisted coding tools.`,

    WELCOME_RETURNING: `👋 *Welcome back!*

Use /createproject to start a new project or /listproject to continue with an existing one.`,
  },
};
