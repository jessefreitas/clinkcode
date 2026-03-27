import { markdownv2 as format } from 'telegram-format';
import { createPatch } from 'diff';
import { TargetTool, PermissionMode } from '../models/types';
import fs from 'node:fs/promises';
import { type AgentMessage, type AgentAssistantMessage, type AgentUserMessage, type AgentResultMessage, type AgentSystemMessage } from '../models/agent-message';

type Edit = { old_string: string; new_string: string; replace_all?: boolean };

export class MessageFormatter {

  formatError(message: string): string {
    return `❌ ${format.bold('Error')}: ${format.escape(message)}`;
  }

  formatSuccess(message: string): string {
    return `✅ ${format.bold('Success')}: ${format.escape(message)}`;
  }

  formatWarning(message: string): string {
    return `⚠️ ${format.bold('Warning')}: ${format.escape(message)}`;
  }

  formatInfo(message: string): string {
    return `ℹ️ ${format.bold('Info')}: ${format.escape(message)}`;
  }

  async formatAgentMessage(message: AgentMessage, permissionMode?: PermissionMode): Promise<string> {
    // Format based on SDK message type
    switch (message.type) {
      case 'assistant':
        return await this.formatAssistantMessage(message, permissionMode);
      case 'user':
        return await this.formatUserMessage(message);
      case 'result':
        return this.formatResultMessage(message);
      case 'system':
        return this.formatSystemMessage(message as AgentSystemMessage);
      // New message types added in claude-agent-sdk
      case 'stream_event':
      case 'tool_progress':
      case 'auth_status':
        return ''; // Skip these internal SDK messages
      default:
        return this.formatGenericMessage(message);
    }
  }

  private async formatAssistantMessage(message: AgentAssistantMessage, permissionMode?: PermissionMode): Promise<string> {
    let result = '🤖 ';

    if (message.message.model) {
      result += `**[${message.message.model}]**`;
      if (permissionMode && permissionMode !== PermissionMode.Default) {
        const modeDisplay = this.formatPermissionMode(permissionMode);
        result += ` ${modeDisplay}`;
      }
      result += '\n';
    }

    result += '\n';

    // Handle content blocks
    if (message.message.content) {
      const contentBlocks = Array.isArray(message.message.content)
        ? message.message.content
        : [message.message.content];

      for (const rawBlock of contentBlocks) {
        const block = rawBlock as any;
        if (typeof block === 'string') {
          result += `${block}\n`;
        } else {
          switch (block.type) {
            case 'text':
              result += `${block.text}\n`;
              break;
            case 'thinking':
              result += `💭 **Thinking process**:\n${block.thinking}\n`;
              break;
            case 'tool_use':
              result += await this.formatToolUse(block.name, block.input);
              break;
            case 'tool_result':
              result += `📤 **Tool result**: \`${block.tool_use_id?.slice(0, 8) + '...'}\`\n`;
              if (block.content) {
                const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                result += `${content}\n`;
              }
              break;
            default:
              result += `❓ **Unknown content type**: \`${block.type}\`\n`;
              result += `\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
          }
        }
      }
    }

    // Add usage statistics
    if (message.message.usage) {
      const usage = message.message.usage;
      result += `\n📊 **Usage statistics**: Input ${usage.input_tokens} tokens, Output ${usage.output_tokens} tokens`;
      if (usage.cache_read_input_tokens) {
        result += `, Cache read ${usage.cache_read_input_tokens} tokens`;
      }
      if (usage.cache_creation_input_tokens) {
        result += `, Cache creation ${usage.cache_creation_input_tokens} tokens`;
      }
      result += '\n';
    }

    // Add stop reason
    if (message.message.stop_reason) {
      const stopReasonMap: Record<string, string> = {
        'end_turn': 'Normal end',
        'max_tokens': 'Max tokens reached',
        'stop_sequence': 'Stop sequence encountered',
        'tool_use': 'Tool use required',
        'pause_turn': 'Turn paused',
        'refusal': 'Response refused'
      };
      result += `🛑 **Stop reason**: ${stopReasonMap[message.message.stop_reason] || message.message.stop_reason}\n`;
    }

    return result.trim();
  }

  private async formatUserMessage(message: AgentUserMessage): Promise<string> {
    let result = '';

    // Handle content blocks
    if (message.message.content) {
      const contentBlocks = Array.isArray(message.message.content)
        ? message.message.content
        : [message.message.content];

      for (const rawBlock of contentBlocks) {
        const block = rawBlock as any;
        if (typeof block === 'string') {
          result += `${block}\n`;
        } else {
          switch (block.type) {
            case 'text':
              result += `${block.text}\n`;
              break;
            case 'image':
              result += '🖼️ **Image**: ';
              if (block.source?.type === 'base64') {
                result += `\`${block.source.media_type}\` (Base64 encoded)\n`;
              } else if (block.source?.type === 'url') {
                result += `[Link](${block.source.url})\n`;
              } else {
                result += 'Unknown image source\n';
              }
              break;
            case 'document':
              result += '📄 **Document**: ';
              if (block.source?.type === 'base64') {
                result += `\`${block.source.media_type}\``;
                if (block.source.data) {
                  result += ` (${Math.round(block.source.data.length * 0.75 / 1024)}KB)`;
                }
              } else if (block.source?.type === 'url') {
                result += `[Link](${block.source.url})`;
              }
              result += '\n';
              break;
            case 'tool_result':
              if (block.is_error) {
                result += '❌ **Execution failed**\n';
              } else {
                result += '✅ **Execution completed**\n';
              }
              if (block.content) {
                const contentStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                const lines = contentStr.split('\n');
                const displayContent = lines.slice(0, 2).join('\n');
                result += `${displayContent}`;
                if (lines.length > 2) {
                  result += '\n...';
                }
                result += '\n';
              }
              break;
            case 'thinking':
              result += `💭 **Thinking process**:\n${block.thinking}\n`;
              break;
            case 'tool_use':
              result += await this.formatToolUse(block.name, block.input);
              break;
            default:
              result += `❓ **Unknown content type**: \`${block.type}\`\n`;
              result += `\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
          }
        }
      }
    }

    // Add parent tool info
    if (message.parent_tool_use_id) {
      result += `🔗 **Parent tool**: \`${message.parent_tool_use_id.slice(0, 8) + '...'}\`\n`;
    }

    return result.trim();
  }

  private formatResultMessage(message: AgentResultMessage): string {
    if (message.subtype === 'success') {
      return `✅ **Execution completed** (${Math.round(message.duration_ms / 1000)}s)`;
    } else {
      return `❌ **Execution failed**: ${message.subtype}`;
    }
  }

  private formatSystemMessage(message: AgentSystemMessage): string {
    if (message.subtype === 'init') {
      return `🚀 **System initialization**\n Model: ${message.model}`;
    }
    return '';
  }

  private formatGenericMessage(message: AgentMessage): string {
    return format.monospaceBlock(JSON.stringify(message, null, 2), 'json');
  }

  /**
   * Format edit operations as diff patches for Telegram
   */
  formatEditAsDiff(filePath: string, oldString: string, newString: string, removeHeaders: boolean = true): string {
    const patch = createPatch(
      filePath,
      oldString + '\n',
      newString + '\n',
      undefined,
      undefined,
      { context: 8 }
    );

    const patchLines = patch.split('\n');
    const patchContent = removeHeaders ? patchLines.slice(4).join('\n') : patch;

    return `\`\`\`diff\n${patchContent}\`\`\``;
  }

  /**
   * Apply edits to file content and return original and modified versions
   */
  private async applyEdits(
    filePath: string,
    edits: Edit[],
  ): Promise<{ original: string; modified: string }> {
    let original: string;
    try {
      original = await fs.readFile(filePath, 'utf8');
    } catch {
      // If file doesn't exist, assume empty content
      original = '';
    }
    let modified = original;

    for (const { old_string, new_string, replace_all } of edits) {
      if (replace_all) {
        modified = modified.replaceAll(old_string, new_string);
      } else {
        // Only do first match replacement
        modified = modified.replace(old_string, new_string);
      }
    }
    return { original, modified };
  }

  /**
   * Convert edits to diff patch format
   */
  private async editsToPatch(filePath: string, edits: Edit[]): Promise<string> {
    const { original, modified } = await this.applyEdits(filePath, edits);

    return createPatch(
      filePath,
      original + '\n',
      modified + '\n',
      '', // oldHeader
      '', // newHeader
      { context: 8 },
    );
  }


  /**
   * Generate diff for MultiEdit operations - can be called after tool execution
   */
  async formatMultiEditResult(filePath: string, edits: Edit[], removeHeaders: boolean = true): Promise<string> {
    try {
      const patch = await this.editsToPatch(filePath, edits);
      const patchLines = patch.split('\n');
      const patchContent = removeHeaders ? patchLines.slice(4).join('\n') : patch;
      return `\`\`\`diff\n${patchContent}\n\`\`\``;
    } catch (error) {
      return `⚠️ Could not generate diff: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }

  async formatToolUse(toolName: string, input?: any, rawDiff: boolean = true): Promise<string> {
    const targetTools = Object.values(TargetTool);

    if (!targetTools.includes(toolName as TargetTool)) {
      // Default formatting for non-target tools
      let result = `🔧 **Tool use**: \`${toolName}\`\n`;
      if (input) {
        result += `📥 **Input**: \n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n`;
      }
      return result;
    }

    // Customized formatting for target tools
    switch (toolName) {
      case TargetTool.TodoWrite:
        return this.formatTodoWriteLoading(input);
      case TargetTool.Read:
        const fileName = input?.file_path ? input.file_path.split('/').pop() : 'file';
        return `📖 **Reading** ${fileName} `;
      case TargetTool.Write:
        const writeFile = input?.file_path ? input.file_path.split('/').pop() : 'file';
        let writeResult = `✍️ **Writing** ${writeFile}\n`;
        if (rawDiff) {
          if (input?.content) {
            const content = input.content;
            const lines = content.split('\n');
            const previewLines = lines.slice(0, 10); // Show first 10 lines
            writeResult += `\`\`\`\n${previewLines.join('\n')}`;
            if (lines.length > 10) {
              writeResult += '\n...';
            }
            writeResult += '\n\`\`\`\n';
          }
        }
        return writeResult;
      case TargetTool.Glob:
        const pattern = input?.pattern || 'files';
        return `🔍 **Use Glob** Searching for ${pattern} `;
      case TargetTool.Edit:
        const editFile = input?.file_path ? input.file_path.split('/').pop() : 'file';
        let result = `✏️ **Editing** ${editFile}\n`;
        if (rawDiff) {
          if (input?.file_path && input?.old_string && input?.new_string) {
            result += this.formatEditAsDiff(input.file_path, input.old_string, input.new_string, true);
          }
        }

        return result;
      case TargetTool.MultiEdit:
        const multiEditFile = input?.file_path ? input.file_path.split('/').pop() : 'file';
        let multiResult = `✏️ **MultiEdit** ${multiEditFile}\n`;

        if (rawDiff) {
          if (input?.file_path && input?.edits && Array.isArray(input.edits)) {
            try {
              const diffText = await this.formatMultiEditResult(input.file_path, input.edits, true);
              multiResult += diffText;
            } catch (error) {
              multiResult += '⚠️ Could not generate diff preview\n';
            }
          }
        }
        return multiResult;
      case TargetTool.LS:
        const dir = input?.path ? input.path.split('/').pop() || 'directory' : 'directory';
        return `📁 **Listing** ${dir} `;
      case TargetTool.Grep:
        const searchPattern = input?.pattern || 'content';
        return `🔎 **Use Grep** Searching for "${searchPattern}" `;
      case TargetTool.Bash:
        const command = input?.command;
        return `⚡ **Running** ${command}\n`;
      case TargetTool.Task:
        const description = input?.description || 'task';
        return `🤖 **Task** Starting ${description}\n`;
      case TargetTool.ExitPlanMode:
        const plan = input?.plan || 'No plan provided';
        return `📋 **Plan Mode**\n\n${plan}\n`;
      default:
        return `🔧 **Tool use**: \`${toolName}\`\n`;
    }
  }

  formatToolResult(toolName: string, content: any, isError: boolean = false): string {
    const targetTools = Object.values(TargetTool);

    if (!targetTools.includes(toolName as TargetTool)) {
      // Default formatting for non-target tools
      if (isError) {
        return '❌ **Execution failed**\n';
      } else {
        return '✅ **Execution completed**\n';
      }
    }

    // Customized formatting for target tools
    if (isError) {
      return this.getErrorMessage(toolName);
    }

    switch (toolName) {
      case TargetTool.TodoWrite:
        return this.formatTodoWriteResult(content);
      case TargetTool.Read:
        return '📄 File content loaded\n';
      case TargetTool.Write:
        return '📝 File written\n';
      case TargetTool.Glob:
        const fileCount = this.extractFileCount(content);
        return `📂 Found ${fileCount} files\n`;
      case TargetTool.Edit:
        return '💾 File updated\n';
      case TargetTool.MultiEdit:
        // For MultiEdit, we want to show the diff, but formatToolResult is sync
        // The actual diff should be handled by the calling code using formatMultiEditResult
        return '💾 Multiple edits applied\n';
      case TargetTool.LS:
        return '📋 Directory listed\n';
      case TargetTool.Grep:
        const matchCount = this.extractMatchCount(content);
        return `🎯 Found ${matchCount} matches\n`;
      case TargetTool.Bash:
        return '✅ Command completed\n';
      case TargetTool.Task:
        return '🎯 Task completed\n';
      case TargetTool.ExitPlanMode:
        return '📋 Plan mode completed\n';
      default:
        return '✅ **Execution completed**\n';
    }
  }

  private getErrorMessage(toolName: string): string {
    switch (toolName) {
      case TargetTool.TodoWrite:
        return '❌ Failed to update tasks\n';
      case TargetTool.Read:
        return '❌ Failed to read file\n';
      case TargetTool.Write:
        return '❌ Failed to write file\n';
      case TargetTool.Glob:
        return '❌ Search failed\n';
      case TargetTool.Edit:
        return '❌ Failed to edit file\n';
      case TargetTool.MultiEdit:
        return '❌ Failed to apply multiple edits\n';
      case TargetTool.LS:
        return '❌ Failed to list directory\n';
      case TargetTool.Grep:
        return '❌ Search failed\n';
      case TargetTool.Bash:
        return '❌ Command failed\n';
      case TargetTool.Task:
        return '❌ Task failed\n';
      case TargetTool.ExitPlanMode:
        return '❌ Failed to exit plan mode\n';
      default:
        return '❌ **Execution failed**\n';
    }
  }

  private extractFileCount(content: any): string {
    if (typeof content === 'string') {
      const lines = content.split('\n').filter(line => line.trim());
      return lines.length.toString();
    }
    return 'some';
  }

  private extractMatchCount(content: any): string {
    if (typeof content === 'string') {
      const lines = content.split('\n').filter(line => line.trim());
      return lines.length.toString();
    }
    return 'some';
  }

  private formatTodoWriteLoading(input: any): string {
    if (!input?.todos || !Array.isArray(input.todos)) {
      return '📝 Managing tasks...\n';
    }

    let result = '📝 **Managing Tasks**\n\n';

    for (const todo of input.todos) {
      const priorityEmoji = this.getPriorityEmoji(todo.priority);
      const statusEmoji = this.getStatusEmoji(todo.status);
      const todoText = todo.status === 'completed'
        ? `~${todo.content}~`
        : todo.content;

      result += `${statusEmoji} ${priorityEmoji} ${todoText}\n`;
    }

    return result;
  }

  private formatTodoWriteResult(_content: any): string {
    // For now, just show completion message
    // In the future, could parse the result to show what changed
    return '✅ **Tasks Updated**\n';
  }

  private getPriorityEmoji(priority: string): string {
    switch (priority) {
      case 'high':
        return '🔴';
      case 'medium':
        return '🟡';
      case 'low':
        return '🟢';
      default:
        return '⚪';
    }
  }

  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'completed':
        return '✅';
      case 'in_progress':
        return '🔄';
      case 'pending':
        return '⏳';
      default:
        return '❓';
    }
  }

  private formatPermissionMode(mode: PermissionMode): string {
    switch (mode) {
      case PermissionMode.AcceptEdits:
        return '**[🟢 Auto-Accept]**';
      case PermissionMode.Plan:
        return '**[📋 Plan Mode]**';
      case PermissionMode.BypassPermissions:
        return '**[🚫 Bypass]**';
      case PermissionMode.Default:
      default:
        return '';
    }
  }

}
