import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { AcpClient, readTextContent } from "./acp_client.js";
import { selectPermissionOption } from "./hitl.js";
import type { Hitl, HitlDecision, PermissionOption, WorkerConfig, WorkerTurn } from "./types.js";

export interface PoolOptions {
  grokBin: string;
  workers: WorkerConfig[];
  hitl: Hitl;
  mock: boolean;
  out: (line: string) => void;
  verbose: boolean;
  /** Override the mock ACP script. Tests use the repo copy. */
  mockScript?: string;
}

interface LiveWorker {
  config: WorkerConfig;
  child: ChildProcess;
  client: AcpClient;
  sessionId: string;
  stderr: string;
  turnText: string;
  decisions: HitlDecision[];
}

interface InitializeResult {
  authMethods?: Array<{ id?: string }>;
  _meta?: { defaultAuthMethodId?: string };
}

interface SessionNewResult {
  sessionId?: string;
}

interface PromptResult {
  stopReason?: string;
  text?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildGrokAgentArgs(worker: WorkerConfig): string[] {
  const args = ["--no-auto-update", "agent"];
  if (worker.profileFile) {
    args.push("--agent-profile", worker.profileFile);
  }
  if (worker.alwaysApprove) {
    args.push("--always-approve");
  }
  args.push("stdio");
  return args;
}

export function agentProfileValue(profile: string | undefined): string | Record<string, unknown> | undefined {
  if (!profile) return undefined;
  const trimmed = profile.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) return parsed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function buildSessionNewParams(worker: WorkerConfig): {
  cwd: string;
  mcpServers: [];
  _meta: Record<string, unknown>;
} {
  const profile = agentProfileValue(worker.profile);
  return {
    cwd: worker.cwd,
    mcpServers: [],
    _meta: {
      rules: worker.rules,
      yoloMode: worker.alwaysApprove,
      ...(profile !== undefined ? { agentProfile: profile } : {}),
    },
  };
}

function defaultMockScript(): string {
  return fileURLToPath(new URL("../scripts/mock-grok-agent.mjs", import.meta.url));
}

export function grokAvailable(bin: string): boolean {
  if (bin.includes("/") || bin.startsWith(".")) {
    try {
      accessSync(bin, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const result = spawnSync("which", [bin], { encoding: "utf8" });
  return result.status === 0;
}

export class WorkerPool {
  private readonly live = new Map<string, LiveWorker>();
  private readonly byName: Map<string, WorkerConfig>;

  constructor(private readonly options: PoolOptions) {
    this.byName = new Map(options.workers.map((worker) => [worker.name, worker]));
  }

  async prompt(name: string, text: string): Promise<WorkerTurn> {
    const worker = await this.ensure(name);
    worker.turnText = "";
    worker.decisions = [];
    let result: PromptResult;
    try {
      const raw = await worker.client.request(
        "session/prompt",
        {
          sessionId: worker.sessionId,
          prompt: [{ type: "text", text }],
        },
        this.options.mock ? 10_000 : 180_000,
      );
      result = isRecord(raw) ? (raw as PromptResult) : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("timed out")) {
        worker.client.notify("session/cancel", { sessionId: worker.sessionId });
      }
      const stderr = worker.stderr.trim();
      throw new Error(
        `${name} prompt failed: ${message}${stderr ? `\n${stderr.slice(-500)}` : ""}`,
      );
    }
    const textOut = worker.turnText.trim() || (typeof result.text === "string" ? result.text.trim() : "");
    return {
      name,
      text: textOut,
      stopReason: typeof result.stopReason === "string" ? result.stopReason : "end_turn",
      decisions: [...worker.decisions],
    };
  }

  async close(): Promise<void> {
    for (const worker of this.live.values()) {
      worker.client.close();
    }
    this.live.clear();
  }

  private async ensure(name: string): Promise<LiveWorker> {
    const existing = this.live.get(name);
    if (existing) return existing;
    const config = this.byName.get(name);
    if (!config) {
      throw new Error(`no worker named ${name}`);
    }
    const live = await this.spawn(config);
    this.live.set(name, live);
    return live;
  }

  private async spawn(config: WorkerConfig): Promise<LiveWorker> {
    const live = {
      config,
      stderr: "",
      turnText: "",
      decisions: [] as HitlDecision[],
    } as LiveWorker;

    const child = this.options.mock ? this.spawnMock(config) : this.spawnGrok(config);
    live.child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      live.stderr = (live.stderr + chunk).slice(-8_000);
      if (this.options.verbose) {
        for (const line of chunk.split("\n")) {
          if (line.trim()) this.options.out(`${config.name}! ${line}`);
        }
      }
    });

    const client = new AcpClient(child, {
      onNotification: (method, params) => this.onNotification(live, method, params),
      onRequest: (method, params) => this.onRequest(live, method, params),
    });
    live.client = client;

    try {
      const init = (await client.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        this.options.mock ? 5_000 : 30_000,
      )) as InitializeResult;
      await this.authenticate(client, init);
      const created = (await client.request(
        "session/new",
        buildSessionNewParams(config),
        this.options.mock ? 5_000 : 30_000,
      )) as SessionNewResult;
      if (!created.sessionId) {
        throw new Error("session/new did not return sessionId");
      }
      live.sessionId = created.sessionId;
    } catch (error) {
      client.close();
      if (client.spawnError?.code === "ENOENT") {
        throw new Error(
          `Could not spawn ${this.options.grokBin}. Install the Grok CLI (\`grok\`) or rerun with --mock.`,
        );
      }
      throw error;
    }
    return live;
  }

  private spawnGrok(config: WorkerConfig): ChildProcess {
    const args = buildGrokAgentArgs(config);
    if (this.options.verbose) {
      this.options.out(`spawn> ${this.options.grokBin} ${args.join(" ")}`);
    }
    return spawn(this.options.grokBin, args, {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GROK_CLIENT_VERSION: "grok-cli-orchestrator/0.1.0",
      },
    });
  }

  private spawnMock(config: WorkerConfig): ChildProcess {
    const script = this.options.mockScript ?? defaultMockScript();
    if (this.options.verbose) {
      this.options.out(`spawn> ${process.execPath} ${script}`);
    }
    return spawn(process.execPath, [script], {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  }

  private async authenticate(client: AcpClient, init: InitializeResult): Promise<void> {
    const methods = new Set(
      (init.authMethods ?? []).map((method) => method.id).filter((id): id is string => Boolean(id)),
    );
    if (methods.size === 0) return;
    let methodId: string | undefined;
    if (process.env.XAI_API_KEY && methods.has("xai.api_key")) {
      methodId = "xai.api_key";
    } else if (methods.has("cached_token")) {
      methodId = "cached_token";
    } else if (init._meta?.defaultAuthMethodId && methods.has(init._meta.defaultAuthMethodId)) {
      methodId = init._meta.defaultAuthMethodId;
    }
    if (!methodId) {
      throw new Error(
        `grok agent requires authentication (${[...methods].join(", ")}). Run \`grok login\` or set XAI_API_KEY.`,
      );
    }
    await client.request(
      "authenticate",
      { methodId, _meta: { headless: true } },
      this.options.mock ? 5_000 : 30_000,
    );
  }

  private onNotification(worker: LiveWorker, method: string, params: unknown): void {
    if (method !== "session/update" || !isRecord(params)) return;
    const update = isRecord(params.update) ? params.update : params;
    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      worker.turnText += readTextContent(update.content);
      return;
    }
    if ((kind === "tool_call" || kind === "tool_call_update") && this.options.verbose) {
      const title = typeof update.title === "string" ? update.title : kind;
      this.options.out(`${worker.config.name}> ${kind}: ${title}`);
    }
  }

  private async onRequest(worker: LiveWorker, method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") {
      throw new Error(`method not found: ${method}`);
    }
    const record = isRecord(params) ? params : {};
    const tool = isRecord(record.toolCall) ? record.toolCall : {};
    const options = Array.isArray(record.options)
      ? record.options.filter(isPermissionOption)
      : [];
    const title =
      typeof tool.title === "string"
        ? tool.title
        : typeof tool.kind === "string"
          ? tool.kind
          : "tool";
    const decision = await this.options.hitl.decide({
      worker: worker.config.name,
      title,
      ...(typeof tool.toolCallId === "string" ? { toolCallId: tool.toolCallId } : {}),
      ...(tool.rawInput !== undefined ? { rawInput: tool.rawInput } : {}),
      options,
    });
    worker.decisions.push(decision);
    const outcome = selectPermissionOption(options, decision);
    if (outcome.outcome === "cancelled") {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: outcome.optionId } };
  }
}

function isPermissionOption(value: unknown): value is PermissionOption {
  if (!isRecord(value)) return false;
  return (
    typeof value.optionId === "string" &&
    typeof value.name === "string" &&
    typeof value.kind === "string"
  );
}
