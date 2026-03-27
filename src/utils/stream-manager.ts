import { AsyncQueue } from './async-queue';

interface StreamInfo<T> {
  controller: AbortController;
  messageQueue: AsyncQueue<T>;
}

export class StreamManager<T> {
  private streams = new Map<number, StreamInfo<T>>();

  getOrCreateStream(chatId: number): AsyncIterable<T> {
    if (!this.streams.has(chatId)) {
      const controller = new AbortController();
      const messageQueue = new AsyncQueue<T>();
      
      this.streams.set(chatId, {
        controller,
        messageQueue
      });
    }
    
    const streamInfo = this.streams.get(chatId)!;
    return this.createPersistentIterable(chatId, streamInfo.messageQueue, streamInfo.controller);
  }

  addMessage(chatId: number, message: T): void {
    const stream = this.streams.get(chatId);
    if (stream && !stream.controller.signal.aborted && !stream.messageQueue.isClosed) {
      stream.messageQueue.enqueue(message);
    } else {
      console.warn(`[StreamManager] Cannot add message to inactive stream for chatId: ${chatId}`);
    }
  }

  getController(chatId: number): AbortController | undefined {
    return this.streams.get(chatId)?.controller;
  }

  abortStream(chatId: number): boolean {
    const stream = this.streams.get(chatId);
    if (stream) {
      stream.controller.abort();
      stream.messageQueue.close();
      this.streams.delete(chatId);
      return true;
    }
    return false;
  }

  isStreamActive(chatId: number): boolean {
    const stream = this.streams.get(chatId);
    return stream ? !stream.controller.signal.aborted && !stream.messageQueue.isClosed : false;
  }

  getStreamStatus(chatId: number): {
    exists: boolean;
    isActive: boolean;
    queueSize: number;
    pendingResolvers: number;
  } {
    const stream = this.streams.get(chatId);
    if (!stream) {
      return {
        exists: false,
        isActive: false,
        queueSize: 0,
        pendingResolvers: 0
      };
    }

    return {
      exists: true,
      isActive: !stream.controller.signal.aborted && !stream.messageQueue.isClosed,
      queueSize: stream.messageQueue.size,
      pendingResolvers: stream.messageQueue.pendingResolvers
    };
  }

  shutdown(): void {
    for (const [chatId] of this.streams) {
      this.abortStream(chatId);
    }
  }

  private async* createPersistentIterable(
    chatId: number, 
    queue: AsyncQueue<T>, 
    controller: AbortController
  ): AsyncIterable<T> {
    try {
      while (!controller.signal.aborted) {
        try {
          const message = await queue.dequeue();
          yield message;
        } catch (error) {
          if (controller.signal.aborted || queue.isClosed) {
            break;
          }
          console.error(`[StreamManager] Error in persistent iterable for chatId ${chatId}:`, error);
          throw error;
        }
      }
    } finally {
      console.debug(`[StreamManager] Persistent iterable ended for chatId: ${chatId}`);
    }
  }
}
