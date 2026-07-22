import type { TerminalInputCommand } from "./api";

const MAX_STARTUP_BUFFER_BYTES = 1024 * 1024;

function commandBytes(command: TerminalInputCommand): number {
  if (command.type === "text" || command.type === "paste") {
    return new TextEncoder().encode(command.text).byteLength;
  }
  return 32;
}

function requiresImmediateFlush(command: TerminalInputCommand): boolean {
  return (
    command.type === "paste" ||
    command.type === "lineBreak" ||
    command.type === "key" ||
    (command.type === "mouse" && command.action !== "move")
  );
}

/**
 * Lossless, ordered frontend input queue. It exists before the PTY actor is
 * ready, batches adjacent text in a microtask, and allows only one IPC batch
 * to be in flight so asynchronous invokes cannot reorder terminal input.
 */
export class TerminalInputPump {
  private starting = true;
  private failed = false;
  private bufferedBytes = 0;
  private startup: TerminalInputCommand[] = [];
  private pending: TerminalInputCommand[] = [];
  private flushScheduled = false;
  private clientSeq = 1;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly sendBatch: (
      clientSeq: number,
      commands: TerminalInputCommand[],
    ) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  push(command: TerminalInputCommand): boolean {
    if (this.failed) return false;
    if (this.starting) {
      const bytes = commandBytes(command);
      if (this.bufferedBytes + bytes > MAX_STARTUP_BUFFER_BYTES) {
        this.onError(new Error("terminal_startup_input_buffer_full"));
        return false;
      }
      this.startup.push(command);
      this.bufferedBytes += bytes;
      return true;
    }

    this.pending.push(command);
    if (requiresImmediateFlush(command)) this.flush();
    else this.scheduleFlush();
    return true;
  }

  ready(): void {
    if (this.failed || !this.starting) return;
    this.starting = false;
    this.pending.push(...this.startup);
    this.startup = [];
    this.bufferedBytes = 0;
    this.flush();
  }

  fail(error?: unknown): void {
    this.failed = true;
    this.startup = [];
    this.pending = [];
    this.bufferedBytes = 0;
    if (error) this.onError(error);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.starting || this.failed || this.pending.length === 0) return;
    const commands = this.pending;
    this.pending = [];
    const seq = this.clientSeq++;
    this.tail = this.tail
      .then(() => this.sendBatch(seq, commands))
      .catch((error) => {
        this.onError(error);
      });
  }
}
