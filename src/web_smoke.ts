import { fileURLToPath, pathToFileURL } from "node:url";
import type { HitlDecision } from "./types.js";
import { startWebServer, type DeskEvent, type HitlView } from "./web_server.js";

const MESSAGE =
  "Research how ACP permission requests work, then sketch a tiny shell health check. Writing the file needs approval.";

const RESEARCH_TASK = "Summarize the facts and constraints. Do not edit files.";
const CODE_TASK = "Sketch the smallest implementation, including the concrete snippet or file.";

export async function runMockUiSmoke(options?: {
  quiet?: boolean;
  decision?: HitlDecision;
}): Promise<void> {
  const quiet = options?.quiet === true;
  const decision = options?.decision ?? "allow";
  const configPath = fileURLToPath(new URL("../orchestrator.yaml", import.meta.url));
  const running = await startWebServer({ mock: true, port: 0, configPath, quiet: true });
  const controller = new AbortController();
  const events: DeskEvent[] = [];
  try {
    const page = await fetch(`${running.url}/`);
    if (!page.ok) throw new Error(`ui page status ${page.status}`);
    const html = await page.text();
    for (const needle of ["Worker sessions", "Orchestrator desk", MESSAGE]) {
      if (!html.includes(needle)) throw new Error(`ui page is missing ${needle}`);
    }
    const style = await fetch(`${running.url}/styles.css`);
    const script = await fetch(`${running.url}/app.js`);
    if (!style.ok || !script.ok) throw new Error("ui assets did not load");
    const scriptText = await script.text();
    for (const needle of ["Allow once", "Deny", "Cancel", "dataset.decision"]) {
      if (!scriptText.includes(needle)) throw new Error(`ui script is missing ${needle}`);
    }

    const empty = await fetch(`${running.url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    if (empty.status !== 400) throw new Error(`empty message status ${empty.status}`);

    const stream = await fetch(`${running.url}/events`, { signal: controller.signal });
    if (!stream.ok || !stream.body) throw new Error(`events status ${stream.status}`);
    const reader = new SseReader(stream.body, events);
    await reader.waitFor(() => events.some((event) => event.type === "snapshot"), 5_000);

    const posted = await fetch(`${running.url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: MESSAGE }),
    });
    if (posted.status !== 202) throw new Error(`message status ${posted.status}`);

    await reader.waitFor(() => pendingHitl(events) !== null, 15_000);
    const hitl = pendingHitl(events);
    if (!hitl) throw new Error("missing permission prompt");
    if (hitl.worker !== "coder" || hitl.title !== "Write scripts/healthcheck.sh") {
      throw new Error(`unexpected permission prompt: ${hitl.worker} ${hitl.title}`);
    }
    const kinds = hitl.options.map((option) => option.kind);
    if (!kinds.includes("allow_once") || !kinds.includes("reject_once")) {
      throw new Error(`permission options missing allow/reject: ${kinds.join(",")}`);
    }

    const hitlIndex = events.findIndex((event) => event.type === "hitl" && event.hitl);
    const researcherChunk = events.findIndex(
      (event) => event.type === "session_chunk" && event.name === "researcher",
    );
    if (researcherChunk < 0 || researcherChunk > hitlIndex) {
      throw new Error("researcher text did not stream before the permission prompt");
    }
    if (!sawStatus(events, "coder", "waiting-permission")) {
      throw new Error("coder session did not enter waiting-permission");
    }
    if (!sawStatus(events, "researcher", "running") || !sawStatus(events, "coder", "running")) {
      throw new Error("expected both worker sessions to be running");
    }

    const blocked = await fetch(`${running.url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "another message while the turn is open" }),
    });
    if (blocked.status !== 409) throw new Error(`expected 409 while busy, got ${blocked.status}`);

    const answered = await fetch(`${running.url}/hitl`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: hitl.id, decision }),
    });
    if (!answered.ok) throw new Error(`hitl status ${answered.status}`);

    await reader.waitFor(() => events.some((event) => event.type === "turn_finished"), 15_000);
    const coderChunk = events.findIndex((event) => event.type === "session_chunk" && event.name === "coder");
    if (coderChunk < hitlIndex) throw new Error("coder text did not stream after the permission prompt");

    const stateRes = await fetch(`${running.url}/state`);
    if (!stateRes.ok) throw new Error(`state status ${stateRes.status}`);
    const state = (await stateRes.json()) as {
      busy: boolean;
      hitl: HitlView | null;
      dialog: Array<{ role: string; text: string }>;
      sessions: Array<{ name: string; status: string; step: number; task: string; text: string }>;
    };
    if (state.busy) throw new Error("desk still busy after the turn");
    if (state.hitl) throw new Error("permission prompt still open");

    const dialog = state.dialog.map((message) => message.text).join("\n");
    for (const needle of [
      MESSAGE,
      "plan (deterministic): researcher -> coder",
      `1. researcher — ${RESEARCH_TASK}`,
      `2. coder — ${CODE_TASK}`,
      "finished 2 steps.",
      `decision: ${decision === "allow" ? "allow once" : decision} (ui)`,
    ]) {
      if (!dialog.includes(needle)) throw new Error(`dialog missing ${needle}`);
    }

    const researcher = state.sessions.find((session) => session.name === "researcher");
    const coder = state.sessions.find((session) => session.name === "coder");
    if (!researcher || !coder) throw new Error("final state is missing a worker session");
    if (researcher.step !== 1 || researcher.task !== RESEARCH_TASK || researcher.status !== "done") {
      throw new Error(`researcher card mismatch: step=${researcher.step} status=${researcher.status} task=${researcher.task}`);
    }
    if (coder.step !== 2 || coder.task !== CODE_TASK || coder.status !== "done") {
      throw new Error(`coder card mismatch: step=${coder.step} status=${coder.status} task=${coder.task}`);
    }
    if (!researcher.text.includes("ACP permission flow")) {
      throw new Error("researcher session text missing the mock research note");
    }
    if (decision === "allow") {
      if (!coder.text.includes("Approved write of scripts/healthcheck.sh")) {
        throw new Error("coder session did not record the approved write");
      }
    } else if (decision === "deny") {
      if (!coder.text.includes("human denied the tool call") || coder.text.includes("Approved write")) {
        throw new Error(`coder deny text was unexpected: ${coder.text}`);
      }
    } else if (!coder.text.includes("human cancelled the tool call") || coder.text.includes("Approved write")) {
      throw new Error(`coder cancel text was unexpected: ${coder.text}`);
    }

    if (!quiet) {
      process.stdout.write(`ui-smoke: plan researcher -> coder\n`);
      process.stdout.write(`ui-smoke: hitl ${hitl.worker}: ${hitl.title}\n`);
      process.stdout.write(`ui-smoke: decision ${decision}\n`);
    }
  } finally {
    controller.abort();
    await running.close();
  }
}

function pendingHitl(events: DeskEvent[]): HitlView | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type === "hitl") return event.hitl;
  }
  return null;
}

function sawStatus(events: DeskEvent[], name: string, status: string): boolean {
  return events.some(
    (event) => event.type === "session" && event.session.name === name && event.session.status === status,
  );
}

class SseReader {
  private buf = "";
  private waiters: Array<() => void> = [];
  private failed: Error | undefined;

  constructor(
    body: ReadableStream<Uint8Array>,
    private readonly events: DeskEvent[],
  ) {
    void this.pump(body);
  }

  waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
    if (this.failed) return Promise.reject(this.failed);
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `timed out waiting for ui events (${this.events.map((event) => event.type).join(" ") || "none"})`,
          ),
        );
      }, timeoutMs);
      const wake = () => {
        if (this.failed) {
          cleanup();
          reject(this.failed);
          return;
        }
        if (!pred()) return;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
      };
      this.waiters.push(wake);
      if (pred()) {
        cleanup();
        resolve();
      }
    });
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buf += decoder.decode(value, { stream: true });
        const parts = this.buf.split("\n\n");
        this.buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((item) => item.startsWith("data:"));
          if (!line) continue;
          this.events.push(JSON.parse(line.slice("data:".length).trim()) as DeskEvent);
        }
        for (const wake of [...this.waiters]) wake();
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      this.failed = error instanceof Error ? error : new Error(String(error));
      for (const wake of [...this.waiters]) wake();
    }
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  return entry.endsWith("/src/web_smoke.ts") || entry.endsWith("/src/web_smoke.js");
}

if (isDirectRun()) {
  runMockUiSmoke()
    .then(() => {
      process.stdout.write("ui-smoke: ok\n");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`ui-smoke: ${message}\n`);
      process.exitCode = 1;
    });
}
