export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AgentTextBlock {
  type: 'text';
  text: string;
}

export interface AgentThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface AgentToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AgentToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

export interface AgentImageBlock {
  type: 'image';
  source?: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface AgentDocumentBlock {
  type: 'document';
  source?: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export type AgentContentBlock =
  | string
  | AgentTextBlock
  | AgentThinkingBlock
  | AgentToolUseBlock
  | AgentToolResultBlock
  | AgentImageBlock
  | AgentDocumentBlock
  | { type: string; [key: string]: unknown };

export interface AgentBaseMessage {
  role: 'assistant' | 'user';
  content: AgentContentBlock[] | AgentContentBlock;
  model?: string;
  usage?: AgentUsage;
  stop_reason?: string;
}

export interface AgentAssistantMessage {
  type: 'assistant';
  message: AgentBaseMessage;
  session_id?: string;
  parent_tool_use_id?: string | null;
}

export interface AgentUserMessage {
  type: 'user';
  message: AgentBaseMessage;
  session_id?: string;
  parent_tool_use_id?: string | null;
}

export interface AgentResultMessage {
  type: 'result';
  subtype: string;
  duration_ms: number;
}

export interface AgentSystemMessage {
  type: 'system';
  subtype: string;
  model?: string;
}

export interface AgentInternalMessage {
  type: 'stream_event' | 'tool_progress' | 'auth_status';
}

export type AgentMessage =
  | AgentAssistantMessage
  | AgentUserMessage
  | AgentResultMessage
  | AgentSystemMessage
  | AgentInternalMessage;

