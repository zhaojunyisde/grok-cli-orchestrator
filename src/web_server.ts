import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultConfigPath, loadConfig } from "./config.js";
import { createHitl } from "./hitl.js";
import { Orchestrator } from "./orchestrator.js";
import type { AppConfig, HitlDecision, PermissionOption, Plan, PlanStep, WorkerTurn } from "./types.js";
import { grokAvailable } from "./worker_pool.js";

export type WorkerStatus = "idle" | "running" | "waiting-permission" | "done" | "error";

export interface SessionView {
  name: string;
  alwaysApprove: boolean;
  status: WorkerStatus;
  /** 1-based step in the current turn, or 0 when this worker was not routed. */
  step: number;
  task: string;
  text: string;
  stopReason?: string;
  error?: string;
}

export interface DialogMessage {
  id: number;
  role: "user" | "orchestrator" | "hitl";
  text: string;
}

export interface HitlView {
  id: string;
  worker: string;
  title: string;
  toolCallId?: string;
  rawInput?: unknown;
  options: PermissionOption[];
}

export interface DeskState {
  mode: "mock" | "real";
  router: string;
  busy: boolean;
  dialog: DialogMessage[];
  sessions: SessionView[];
  hitl: HitlView | null;
}

export type DeskEvent =
  | { type: "snapshot"; state: DeskState }
  | { type: "dialog"; message: DialogMessage }
  | { type: "session"; session: SessionView }
  | { type: "sessions"; sessions: SessionView[] }
  | { type: "session_chunk"; name: string; chunk: string }
  | { type: "hitl"; hitl: HitlView | null }
  | { type: "busy"; busy: boolean }
  | { type: "turn_finished"; ok: boolean; error?: string };

export interface WebServerOptions {
  mock?: boolean;
  port?: number;
  host?: string;
  configPath?: string;
  /** Skip the CLI-style transcript on stdout. Tests use this. */
  quiet?: boolean;
}

export interface RunningWebServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const UI_DIR = path.dirname(fileURLToPath(new URL("../ui/index.html", import.meta.url)));
const FILES: Record<string, { name: string; type: string }> = {
  "/": { name: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
};

function copySession(session: SessionView): SessionView {
  return {
    name: session.name,
    alwaysApprove: session.alwaysApprove,
    status: session.status,
    step: session.step,
    task: session.task,
    text: session.text,
    ...(session.stopReason ? { stopReason: session.stopReason } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

function shownRouter(mock: boolean, config: AppConfig): string {
  if (mock || config.router === "deterministic") return "deterministic";
  if (config.router === "auto" && !grokAvailable(config.grokBin)) return "deterministic";
  return "grok";
}

export function startWebServer(options: WebServerOptions = {}): Promise<RunningWebServer> {
  const mock = options.mock !== false;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const quiet = options.quiet === true;
  const config = loadConfig(options.configPath ?? defaultConfigPath());
  if (process.env.GROK_BIN && process.env.GROK_BIN.trim() !== "") {
    config.grokBin = process.env.GROK_BIN.trim();
  }
  if (!mock && !grokAvailable(config.grokBin)) {
    throw new Error(
      `grok binary not found (${config.grokBin}). Install the Grok CLI and run \`grok login\`, or start the UI without --real.`,
    );
  }

  const mode = mock ? "mock" : "real";
  const router = shownRouter(mock, config);
  const state: DeskState = {
    mode,
    router,
    busy: false,
    dialog: [],
    sessions: config.workers.map((worker) => ({
      name: worker.name,
      alwaysApprove: worker.alwaysApprove,
      status: "idle",
      step: 0,
      task: "",
      text: "",
    })),
    hitl: null,
  };

  const clients = new Set<ServerResponse>();
  const pendingHitl = new Map<string, {
    resolve: (decision: HitlDecision) => void;
    reject: (error: Error) => void;
  }>();
  let dialogSeq = 0;
  let hitlSeq = 0;
  let activeWorker: string | null = null;
  let turn: Promise<void> | null = null;
  let shuttingDown = false;
  let closed: Promise<void> | null = null;

  function broadcast(event: DeskEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  function pushDialog(role: DialogMessage["role"], text: string): void {
    const message: DialogMessage = { id: ++dialogSeq, role, text };
    state.dialog.push(message);
    if (state.dialog.length > 300) state.dialog.splice(0, state.dialog.length - 300);
    broadcast({ type: "dialog", message });
  }

  function sessionByName(name: string): SessionView | undefined {
    return state.sessions.find((session) => session.name === name);
  }

  function resetForPlan(plan: Plan): void {
    const steps = new Map<string, { step: PlanStep; index: number }>();
    plan.steps.forEach((step, index) => {
      if (!steps.has(step.worker)) steps.set(step.worker, { step, index });
    });
    for (const session of state.sessions) {
      const assigned = steps.get(session.name);
      session.status = "idle";
      session.text = "";
      delete session.stopReason;
      delete session.error;
      if (assigned) {
        session.step = assigned.index + 1;
        session.task = assigned.step.task;
      } else {
        session.step = 0;
        session.task = "";
      }
    }
    broadcast({ type: "sessions", sessions: state.sessions.map(copySession) });
    const lines = plan.steps.map((step, index) => `${index + 1}. ${step.worker} — ${step.task}`);
    pushDialog("orchestrator", ["Subtasks:", ...lines].join("\n"));
  }

  const say = (line: string) => {
    if (!quiet) process.stdout.write(`${line}\n`);
    if (line.startsWith("orchestrator>")) {
      pushDialog("orchestrator", line.slice("orchestrator>".length).trim());
    } else if (line.startsWith("hitl>")) {
      pushDialog("hitl", line.slice("hitl>".length).trim());
    }
  };

  const hitl = createHitl({
    decision: "ask",
    sourceLabel: "ui",
    out: say,
    interactive: false,
    decideAsync: (prompt) => {
      const id = `hitl-${++hitlSeq}`;
      const view: HitlView = {
        id,
        worker: prompt.worker,
        title: prompt.title,
        options: prompt.options,
        ...(prompt.toolCallId ? { toolCallId: prompt.toolCallId } : {}),
        ...(prompt.rawInput !== undefined ? { rawInput: prompt.rawInput } : {}),
      };
      state.hitl = view;
      const session = sessionByName(prompt.worker);
      if (session) {
        session.status = "waiting-permission";
        broadcast({ type: "session", session: copySession(session) });
      }
      broadcast({ type: "hitl", hitl: view });
      return new Promise<HitlDecision>((resolve, reject) => {
        pendingHitl.set(id, { resolve, reject });
      }).then((decision) => {
        pendingHitl.delete(id);
        if (state.hitl?.id === id) state.hitl = null;
        if (session && session.status === "waiting-permission") {
          session.status = "running";
          broadcast({ type: "session", session: copySession(session) });
        }
        broadcast({ type: "hitl", hitl: null });
        return decision;
      }, (error: unknown) => {
        pendingHitl.delete(id);
        if (state.hitl?.id === id) {
          state.hitl = null;
          broadcast({ type: "hitl", hitl: null });
        }
        throw error;
      });
    },
  });

  const orchestrator = new Orchestrator(config, hitl, say, {
    mock,
    verbose: false,
    // A person needs time to read the session cards and choose allow / deny / cancel.
    promptTimeoutMs: 30 * 60_000,
    events: {
      onPlan: (plan) => resetForPlan(plan),
      onWorkerStart: (step) => {
        activeWorker = step.worker;
        const session = sessionByName(step.worker);
        if (!session) return;
        session.status = "running";
        session.task = step.task;
        session.text = "";
        delete session.error;
        broadcast({ type: "session", session: copySession(session) });
      },
      onWorkerChunk: (name, chunk) => {
        const session = sessionByName(name);
        if (session) session.text += chunk;
        broadcast({ type: "session_chunk", name, chunk });
      },
      onWorkerDone: (turn: WorkerTurn) => {
        if (activeWorker === turn.name) activeWorker = null;
        const session = sessionByName(turn.name);
        if (!session) return;
        session.status = "done";
        session.text = turn.text;
        session.stopReason = turn.stopReason;
        delete session.error;
        broadcast({ type: "session", session: copySession(session) });
      },
    },
  });

  function finishTurn(ok: boolean, error?: string): void {
    broadcast({
      type: "turn_finished",
      ok,
      ...(error ? { error } : {}),
    });
    state.busy = false;
    activeWorker = null;
    broadcast({ type: "busy", busy: false });
  }

  function startTurn(text: string): void {
    state.busy = true;
    broadcast({ type: "busy", busy: true });
    pushDialog("user", text);
    if (!quiet) process.stdout.write(`you> ${text}\n`);
    turn = (async () => {
      try {
        await orchestrator.handle(text);
        finishTurn(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (activeWorker) {
          const session = sessionByName(activeWorker);
          if (session) {
            session.status = "error";
            session.error = message;
            broadcast({ type: "session", session: copySession(session) });
          }
        }
        const waiting = [...pendingHitl.values()];
        pendingHitl.clear();
        for (const pending of waiting) pending.reject(error instanceof Error ? error : new Error(message));
        if (state.hitl) {
          state.hitl = null;
          broadcast({ type: "hitl", hitl: null });
        }
        pushDialog("orchestrator", message);
        finishTurn(false, message);
      }
    })();
  }

  function resolveHitl(id: string, decision: HitlDecision): boolean {
    const pending = pendingHitl.get(id);
    if (!pending) return false;
    pendingHitl.delete(id);
    pending.resolve(decision);
    return true;
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, 400, { error: message });
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true, mode: state.mode, router: state.router, busy: state.busy });
      return;
    }
    if (req.method === "GET" && pathname === "/state") {
      sendJson(res, 200, publicState());
      return;
    }
    if (req.method === "GET" && pathname === "/events") {
      serveEvents(req, res);
      return;
    }
    if (req.method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && FILES[pathname]) {
      await serveStatic(pathname, res);
      return;
    }
    if (req.method === "POST" && pathname === "/message") {
      if (shuttingDown) {
        sendJson(res, 503, { error: "the desk is shutting down" });
        return;
      }
      const body = await readJson(req);
      const text = isRecord(body) && typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        sendJson(res, 400, { error: "message text is required" });
        return;
      }
      if (state.busy) {
        sendJson(res, 409, { error: "the orchestrator is still on the previous turn" });
        return;
      }
      startTurn(text);
      sendJson(res, 202, { ok: true });
      return;
    }
    if (req.method === "POST" && pathname === "/hitl") {
      const body = await readJson(req);
      const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
      const decision = isRecord(body) ? body.decision : undefined;
      if (decision !== "allow" && decision !== "deny" && decision !== "cancel") {
        sendJson(res, 400, { error: "decision must be allow, deny, or cancel" });
        return;
      }
      if (!resolveHitl(id, decision)) {
        sendJson(res, 404, { error: "that permission prompt is no longer waiting" });
        return;
      }
      sendJson(res, 200, { ok: true, decision });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  function publicState(): DeskState {
    return {
      mode: state.mode,
      router: state.router,
      busy: state.busy,
      dialog: state.dialog,
      sessions: state.sessions.map(copySession),
      hitl: state.hitl,
    };
  }

  function serveEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: "snapshot", state: publicState() } satisfies DeskEvent)}\n\n`);
    const heartbeat = setInterval(() => {
      res.write(`: ping\n\n`);
    }, 15_000);
    heartbeat.unref();
    const drop = () => {
      clearInterval(heartbeat);
      clients.delete(res);
    };
    req.on("close", drop);
    res.on("error", drop);
  }

  async function doClose(): Promise<void> {
    shuttingDown = true;
    for (const pending of pendingHitl.values()) pending.resolve("cancel");
    pendingHitl.clear();
    const inFlight = turn;
    if (inFlight) {
      await Promise.race([
        inFlight.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    await orchestrator.close();
    if (inFlight) await inFlight.catch(() => undefined);
    for (const client of clients) client.end();
    clients.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      const bound = address && typeof address !== "string" ? address.port : port;
      resolve({
        url: `http://${host}:${bound}`,
        port: bound,
        close: () => {
          if (!closed) closed = doClose();
          return closed;
        },
      });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const file = FILES[pathname];
  if (!file) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const body = await readFile(path.join(UI_DIR, file.name));
  res.writeHead(200, {
    "Content-Type": file.type,
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WebArgs {
  help: boolean;
  mock: boolean;
  port: number;
  host: string;
  configPath?: string;
}

export function parseWebArgs(argv: string[]): WebArgs {
  const args: WebArgs = {
    help: false,
    mock: true,
    port: envPort(),
    host: "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg ?? "argument"}`);
      }
      i += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--mock") args.mock = true;
    else if (arg === "--real") args.mock = false;
    else if (arg === "--port") args.port = parsePort(next());
    else if (arg === "--host") args.host = next();
    else if (arg === "--config") args.configPath = next();
    else throw new Error(`unknown argument: ${arg ?? ""}`);
  }
  return args;
}

function envPort(): number {
  const raw = process.env.PORT;
  if (!raw) return 4173;
  return parsePort(raw);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`port must be an integer from 0 to 65535 (got ${value})`);
  }
  return port;
}

const WEB_HELP = `grok-cli-orchestrator ui

One browser dialog with the orchestrator. Worker sessions stream beside it.
Mock mode is the default, so grok and XAI_API_KEY are not required.

Usage
  npm run ui
  npm run ui -- --real
  npm run ui:smoke

Options
  --mock           Do not spawn grok. This is the default.
  --real           Spawn grok. Requires the CLI on PATH and grok login or XAI_API_KEY.
  --port <n>       Listen port. Default 4173, or PORT.
  --host <addr>    Listen address. Default 127.0.0.1.
  --config <file>  Worker list. Default orchestrator.yaml.
  --help           Show this help.
`;

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  return entry.endsWith("/src/web_server.ts") || entry.endsWith("/src/web_server.js");
}

if (isDirectRun()) {
  try {
    const args = parseWebArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(`${WEB_HELP}\n`);
    } else {
      const running = await startWebServer({
        mock: args.mock,
        port: args.port,
        host: args.host,
        ...(args.configPath ? { configPath: args.configPath } : {}),
      });
      const config = loadConfig(args.configPath ?? defaultConfigPath());
      const names = config.workers
        .map((worker) => `${worker.name}${worker.alwaysApprove ? "" : "*"}`)
        .join(",");
      process.stdout.write(
        `grok-cli-orchestrator ui  mode=${args.mock ? "mock" : "real"}  http://${args.host}:${running.port}  workers=${names}\n`,
      );
      process.stdout.write("workers marked * ask you before tools run.\n");
      const stop = () => {
        void running.close().finally(() => process.exit(130));
      };
      process.once("SIGINT", stop);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`orchestrator> ${message}\n`);
    process.exitCode = 1;
  }
}
