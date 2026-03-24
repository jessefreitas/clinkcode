# Clink Code

<p align="center">
  <img src="assets/banner.jpeg" alt="Clink Code" />
</p>

A powerful Telegram bot that integrates with Claude Code via the Claude Agent SDK to provide AI-powered coding assistance directly through Telegram. **Uses telegram polling mode - runs on any computer with internet connection, no public IP or domain required.**

This bot allows users to interact with Claude's coding capabilities in a conversational interface with features like project management, file browsing, and comprehensive permission controls.

## Features

- **Claude Agent SDK Integration**: Direct integration with Anthropic's Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **Project Management**: Create, list, and manage coding projects
- **File Browser**: Navigate and explore project directories through Telegram
- **Model Selection**: Switch between Claude Opus 4.5, Sonnet 4.5, and Haiku 4.5 models
- **Permission System**: Multiple permission modes for secure interaction
- **Session Management**: Persistent user sessions with Redis or memory storage
- **Tool Handling**: Advanced tool use detection and management
- **Message Batching**: Efficient message processing and delivery
- **Interactive CLI**: Setup wizard and gateway management via `clinkcode` command
- **Onboarding Flow**: Guided first-time setup for new Telegram users
- **Photo Input**: Send images to Claude for visual analysis
- **Voice Input**: Send voice messages, auto-transcribed via ASR and forwarded to Claude
- **User Whitelist**: Bypass authentication for trusted Telegram user IDs
- **Cloudflare Workers**: Optional Workers integration for diff and file view

## Mobile-Optimized Experience for Telegram

This bot is specifically designed and optimized for Telegram usage scenarios, providing an excellent mobile experience through several key innovations:

### 1. **Natural Permission Control**
Provides natural permission control workflow through an integrated permission system. Users can easily approve or deny tool operations through intuitive inline keyboards, making permission management seamless on mobile devices.

### 2. **Visual Diff Display for Edits**
All code editing operations display comprehensive diff views, allowing users to review changes before approval. This visual feedback is essential for mobile users who need clear context about what changes are being made to their code.

### 3. **Integrated File Browser**
Features a built-in file browser with keyboard navigation that makes it easy to explore project directories directly within Telegram. Users can navigate folder structures, view files, and understand project context without leaving the chat interface.

### 4. **Essential Operation Support**
Supports commonly needed operations optimized for chat interface:
- `/clear` - Clear current session and start fresh
- `/abort` (ESC equivalent) - Abort current Claude query
- `/plan` - Enter planning mode for code design discussions
- Quick permission mode switches (`/default`, `/acceptedits`, `/bypass`)

### 5. **Tool Interaction Adaptation**
All Claude Code tools are adapted for Telegram's message-based interface:
- **Streamlined Information Display**: Complex tool outputs are formatted for mobile readability
- **Interactive Confirmations**: File operations, code changes, and tool executions use inline keyboards for one-tap approval

These optimizations ensure that users can effectively manage coding projects, review changes, and interact with AI assistance comfortably from their mobile devices through Telegram.

## Installation & Deployment

### Easy Setup - No Server Required

This bot uses **Telegram polling mode**, which means:
- ✅ No public IP address needed
- ✅ No domain name required  
- ✅ No port forwarding or firewall configuration
- ✅ Works behind NAT/firewall
- ✅ Can run on any computer with internet access
- ✅ Perfect for personal development machines or private servers

### Prerequisites

- Node.js 18+ 
- Package manager: pnpm (recommended), npm, or yarn
- Redis (optional, for persistent storage)
- Claude Code CLI tool

### Quick Start

1. Clone the repository:
```bash
git clone https://github.com/jonesfernandess/clinkcode.git
cd clinkcode
```

2. Install dependencies:
```bash
pnpm install
```

3. Run the interactive setup wizard:
```bash
pnpm run build
pnpm run cli
# or, if installed globally:
clinkcode setup
```

The wizard will guide you through:
- Detecting your Claude CLI installation
- Setting up your Telegram bot token (from `@BotFather`)
- Configuring allowed users
- Choosing a working directory
- Selecting storage type

4. Start the bot:
```bash
# Via CLI (recommended)
pnpm run cli
# Then select "Start gateway" from the menu

# Or directly:
pnpm run dev    # Development mode
pnpm run build && pnpm start  # Production mode
```

### CLI Commands

After building, the `clinkcode` CLI provides:

```bash
clinkcode                  # Interactive menu
clinkcode setup            # Run setup wizard
clinkcode start            # Start the gateway
clinkcode stop             # Stop the gateway
clinkcode status           # Show gateway status
clinkcode help             # Show help
```

Configuration is stored in `~/.clinkcode/` (config.json and .env).

### Cloudflare Workers (Optional)

**When `WORKERS_ENABLED=true`, you need to deploy Cloudflare Workers and configure environment variables:**

#### 1. Local Environment Setup
In your `~/.clinkcode/.env` file (or configure via the CLI wizard):
```env
WORKERS_ENABLED=true
WORKERS_ENDPOINT=your_workers_endpoint
WORKERS_API_KEY=your_secure_api_key_here
```

#### 2. Create KV Bindings and Deploy Workers
**Before deploying, you need to create KV namespaces in Cloudflare dashboard:**
1. Go to Cloudflare Dashboard > Workers & Pages > KV
2. Create a new KV namespace (name:"CHATCODE")
3. Copy the KV namespace ID and update `wrangler.toml` with the correct binding ID

```bash
cd workers
pnpm install
wrangler deploy
```

#### 3. Configure Workers Environment Variables
In the Cloudflare Workers dashboard, set the following environment variable:
- **Variable Name**: `API_KEY`
- **Value**: `{WORKERS_API_KEY}` (same value as in your local `.env` file)

#### 4. Workers Features
The Workers service provides:
- Diff content viewing service (`/api/diff`)
- File viewing service (`/api/file`)
- HTML rendering interface (`/diff`, `/file`)

## Configuration

The recommended way to configure the bot is through the interactive CLI wizard (`clinkcode setup`), which stores settings in `~/.clinkcode/`.

Alternatively, you can create a `.env` file manually with the following environment variables:

### Required Configuration

```env
TG_BOT_TOKEN=your_telegram_bot_token  # Get this from @BotFather on Telegram
BOT_MODE=polling  # Uses polling mode - no public IP or domain needed
CLAUDE_CODE_PATH=claude
WORK_DIR=~/clinkcode-projects  # Directory where GitHub projects will be cloned
```

### Optional Configuration

```env
# Storage
STORAGE_TYPE=redis  # or 'memory'
REDIS_URL=redis://localhost:6379
SESSION_TIMEOUT=7d

# Security
SECURITY_SECRET_REQUIRED=false
SECURITY_SECRET_TOKEN=your_secret_token

# ASR (optional, for voice message support)
ASR_ENABLED=false
ASR_ENDPOINT=http://localhost:8600

# User whitelist (bypass authentication)
SECURITY_WHITELIST=123456789,987654321

# Workers (optional)
WORKERS_ENABLED=false
WORKERS_ENDPOINT=your_workers_endpoint
WORKERS_API_KEY=your_workers_api_key
```

## Authentication Configuration

By default, anyone who finds your bot can use it. To protect your Claude Code access, you can enable authentication.

### Enable Authentication

Add these environment variables to your `.env`:

```env
SECURITY_SECRET_REQUIRED=true
SECURITY_SECRET_TOKEN=your_secret_password_here
```

### User Whitelist

You can whitelist specific Telegram user IDs to bypass authentication entirely:

```env
SECURITY_WHITELIST=123456789,987654321
```

To find your Telegram user ID, message [@userinfobot](https://t.me/userinfobot) on Telegram.

### Usage

When authentication is enabled:
1. New users must send the secret token to the bot before they can use it
2. Use `/auth` command to check authentication status. send `/auth token`
3. Authenticated users stay logged in until the session expires
4. Whitelisted users skip authentication entirely

Generate a secure token:
```bash
openssl rand -hex 16
```

## Usage

### Bot Commands

- `/start` - Initialize the bot and start onboarding for new users
- `/createproject` - Create a new coding project
- `/listproject` - List all available projects
- `/exitproject` - Exit current project
- `/help` - Show help information
- `/status` - Show current session status
- `/ls` - Browse current directory
- `/auth` - Authentication management
- `/abort` - Abort current Claude query
- `/clear` - Clear current session
- `/resume` - Resume a previous Claude session
- `/model` - View and switch Claude models
- `/diff` - View diff of current changes
- `/resetonboarding` - Restart the onboarding flow

### Model Selection

Switch between different Claude models for different use cases:

- `/model` - Display current model and show selection keyboard
- `/model opus` - Switch to Claude Opus 4.5 (most capable, default)
- `/model sonnet` - Switch to Claude Sonnet 4.5 (balanced)
- `/model haiku` - Switch to Claude Haiku 4.5 (fastest)

**Available Models:**
- **Opus 4.5** (default): Most capable model for complex coding tasks
- **Sonnet 4.5**: Balanced performance and speed
- **Haiku 4.5**: Fastest response times for simple tasks

### Permission Modes

- `/default` - Default permission mode
- `/acceptedits` - Accept all edit operations
- `/plan` - Planning mode (read-only)
- `/bypass` - Bypass all permission checks

### Multimodal Input

- **Photos**: Send an image (with optional caption) and Claude will analyze it visually
- **Voice**: Send a voice message and it will be transcribed to text via ASR, then sent to Claude (requires `ASR_ENABLED=true` and a running ASR service)

### ASR Service (Optional)

To enable voice message support, deploy the bundled ASR service:

```bash
cd asr-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install transformers tiktoken
# ffmpeg is also required: brew install ffmpeg (macOS) / sudo apt install ffmpeg (Linux)
uvicorn server:app --host 0.0.0.0 --port 8600
```

The first startup downloads the ~2GB Fun-ASR-Nano model. After that, set `ASR_ENABLED=true` in your `.env`.

### Text Interaction

Simply send text messages to the bot to interact with Claude Code. The bot will:

1. Process your message through Claude Code
2. Handle any tool uses or file operations
3. Return formatted responses with syntax highlighting
4. Manage project context and file browsing

## Architecture

The bot is built with a modular architecture consisting of:

- **Main Application** (`src/main.ts`): Entry point and orchestration
- **Claude Manager** (`src/handlers/claude.ts`): Claude Agent SDK integration
- **Telegram Handler** (`src/handlers/telegram.ts`): Telegram bot logic coordination
- **Storage Layer**: Redis or memory-based session storage
- **Permission System**: Integrated permission control for tool usage
- **Workers Support**: Optional Cloudflare Workers integration

### Message Flow Architecture

```mermaid
sequenceDiagram
    participant User
    participant TG as Telegram
    participant Bot as Telegram Bot
    participant Claude as Claude Code SDK
    participant PM as Permission Manager

    User->>TG: Send message
    TG->>Bot: Poll/receive message
    Bot->>Claude: Process message via SDK

    alt Tool requires permission
        Claude->>PM: Request permission
        PM->>TG: Send permission request to user
        TG->>User: Show permission dialog
        User->>TG: Approve/Deny
        TG->>PM: User response
        PM->>Claude: Return permission result
    end

    Claude->>Bot: Return response
    Bot->>TG: Send response
    TG->>User: Display message
```

The architecture follows this flow:

1. **User Input**: User sends a message through Telegram
2. **Message Reception**: Bot polls Telegram API and receives the message
3. **Claude Processing**: Message is forwarded to Claude Code SDK for processing
4. **Permission Check**: If Claude requires tool use permissions:
   - Claude Code SDK calls the permission manager's canUseTool function
   - Permission manager sends permission request to user via Telegram
   - User approves or denies the request through inline keyboard
   - Permission manager returns the permission result to Claude Code SDK
5. **Response Generation**: Claude processes the request and generates response
6. **Message Delivery**: Bot sends the formatted response back to user via Telegram

## Development

### Project Structure

```
src/
├── cli.ts           # Interactive CLI (clinkcode command)
├── main.ts          # Entry point and orchestration
├── config/          # Configuration management
├── constants/       # Constants and messages
├── handlers/        # Core handlers
│   ├── claude.ts    # Claude Agent SDK integration
│   ├── telegram.ts  # Telegram coordination
│   ├── github.ts    # GitHub operations
│   ├── directory.ts # Directory management
│   ├── permission-manager.ts # Permission handling
│   └── telegram/    # Telegram-specific handlers
│       ├── callbacks/   # Inline keyboard interactions
│       ├── commands/    # Bot command handler
│       ├── file-browser/ # Directory navigation
│       ├── keyboards/   # Keyboard factory
│       ├── messages/    # Text, photo, voice handling
│       ├── project/     # Project management
│       ├── tools/       # Tool approval/rejection
│       └── utils/       # Telegram utilities
├── models/          # Data models and types
├── queue/           # Message batching
├── server/          # Express server
├── services/        # Business logic services
│   ├── auth-service.ts        # Authentication
│   ├── onboarding-store.ts    # Onboarding state
│   └── telegram-sender.ts     # Message delivery
├── storage/         # Storage abstraction layer
└── utils/           # Utility functions
    ├── formatter.ts             # Message formatting
    ├── stream-manager.ts        # Streaming responses
    ├── claude-session-reader.ts # Session resumption
    └── async-queue.ts           # Async queue

asr-service/        # Fun-ASR speech recognition service
workers/            # Cloudflare Workers integration
```

### Available Scripts

- `pnpm run build` - Build TypeScript to JavaScript
- `pnpm start` - Start the production bot
- `pnpm run cli` - Launch the interactive CLI menu
- `pnpm run dev` - Start development server with watch mode
- `pnpm run watch` - Watch mode for development
- `pnpm run lint` - Run ESLint
- `pnpm run lint:fix` - Fix linting issues
- `pnpm run format` - Format code with Prettier
- `pnpm run asr` - Start the ASR service (requires venv setup)

### Key Components

#### Claude Manager
Handles all interactions with the Claude Agent SDK, including:
- Message streaming and processing
- Session management and resumption
- Tool use detection and extraction
- Query abortion and lifecycle management

#### Telegram Handler
Coordinates all Telegram bot functionality:
- Command routing and processing
- Message handling and formatting
- Callback query management
- File browser integration

#### Storage Layer
Provides abstraction for user session storage:
- Redis backend for production
- Memory backend for development
- Session timeout and cleanup
- User authentication state

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues and questions:
- Check the existing issues
- Create a new issue with detailed information
- Include logs and configuration (without sensitive data)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=jonesfernandess/clinkcode&type=Date)](https://www.star-history.com/#jonesfernandess/clinkcode&Date)