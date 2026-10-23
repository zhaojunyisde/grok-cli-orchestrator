import { writeSync } from "node:fs";
import readline from "node:readline";
import type { ChildProcess } from "node:child_process";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AcpHandlers {
  onNotification?: (method: string, params: unknown) => void;
  /** Throw an Error whose message starts with "method not found" for JSON-RPC -32601. */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Newline-delimited JSON-RPC client for `grok agent stdio`.
 * Reads stdout, writes stdin, and answers reverse requests (permission prompts)
 * while a `session/prompt` call is still outstanding.
 */
export class AcpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly rl: readline.Interface;
  private closed = false;
  spawnError: NodeJS.ErrnoException | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly handlers: AcpHandlers = {},
  ) {
    if (!child.stdout) {
      throw new Error("agent process has no stdout");
    }
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.onLine(line));
    child.on("error", (error: NodeJS.ErrnoException) => {
      this.spawnError = error;
      this.failAll(error);
    });
    child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.failAll(new Error(`agent process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("agent process is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rl.close();
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
    const killer = setTimeout(() => {
      this.child.kill("SIGKILL");
    }, 500);
    killer.unref();
    this.child.once("exit", () => clearTimeout(killer));
    this.failAll(new Error("agent process closed"));
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.handlers.onNotification?.("client/ignored-stdout", trimmed.slice(0, 300));
      return;
    }
    if (message.method && message.id !== undefined) {
      void this.dispatchRequest(message);
      return;
    }
    if (message.id !== undefined && !message.method) {
      const id = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      this.handlers.onNotification?.(message.method, message.params ?? {});
    }
  }

  private async dispatchRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    if (id === undefined) return;
    try {
      if (!this.handlers.onRequest || !message.method) {
        this.respondError(id, -32601, `method not found: ${message.method ?? ""}`);
        return;
      }
      const result = await this.handlers.onRequest(message.method, message.params ?? {});
      this.respond(id, result ?? {});
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const code = text.startsWith("method not found") ? -32601 : -32603;
      this.respondError(id, code, text);
    }
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private write(message: unknown): void {
    const payload = `${JSON.stringify(message)}\n`;
    const stdin = this.child.stdin;
    if (!stdin) return;
    const maybeFd = (stdin as unknown as { fd?: unknown }).fd;
    if (typeof maybeFd === "number") {
      try {
        writeSync(maybeFd, payload);
        return;
      } catch {
        // Non-blocking pipes can refuse a sync write. The stream write still queues it.
      }
    }
    stdin.write(payload);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function readTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => readTextContent(part)).join("");
  }
  if (typeof content === "object" && content !== null && "text" in content) {
    const text = (content as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}
