import { deterministicPlan, planWithGrok } from "./router.js";
import type { AppConfig, Hitl, Plan, WorkerTurn } from "./types.js";
import { grokAvailable, WorkerPool } from "./worker_pool.js";

export function workerPrompt(userText: string, task: string, prior: WorkerTurn[]): string {
  const notes = prior.length
    ? prior
        .map((turn) => `## ${turn.name}\n${turn.text.slice(0, 4_000)}`)
        .join("\n\n")
    : "(none)";
  return [`Task: ${task}`, "", "User request:", userText, "", "Notes from earlier workers:", notes].join("\n");
}

export interface OrchestratorOptions {
  mock: boolean;
  verbose: boolean;
  /** Overrides config.router. Mock mode always uses the deterministic router. */
  router?: AppConfig["router"];
}

/**
 * The human talks only to this object. It plans a route, prompts each
 * worker, and pauses on the human-in-the-loop callback when a worker asks
 * for permission.
 */
export class Orchestrator {
  private readonly pool: WorkerPool;
  private readonly routerMode: AppConfig["router"];

  constructor(
    private readonly config: AppConfig,
    hitl: Hitl,
    private readonly out: (line: string) => void,
    options: OrchestratorOptions,
  ) {
    this.routerMode = options.mock ? "deterministic" : (options.router ?? config.router);
    this.pool = new WorkerPool({
      grokBin: config.grokBin,
      workers: config.workers,
      hitl,
      mock: options.mock,
      out,
      verbose: options.verbose,
    });
  }

  async handle(userText: string): Promise<void> {
    const message = userText.trim();
    if (!message) return;
    const plan = await this.route(message);
    const chain = plan.steps.map((step) => step.worker).join(" -> ");
    this.out(`orchestrator> plan (${plan.source}): ${chain}`);
    const turns: WorkerTurn[] = [];
    for (const step of plan.steps) {
      const turn = await this.pool.prompt(step.worker, workerPrompt(message, step.task, turns));
      turns.push(turn);
      const body = turn.text || `(no assistant text, stopReason=${turn.stopReason})`;
      this.out("");
      this.out(`${turn.name}>`);
      this.out(body);
    }
    const count = turns.length;
    this.out("");
    this.out(`orchestrator> finished ${count} step${count === 1 ? "" : "s"}.`);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  private async route(message: string): Promise<Plan> {
    const names = this.config.workers.map((worker) => worker.name);
    const fallback = (): Plan => ({
      source: "deterministic",
      steps: deterministicPlan(message, names),
    });
    if (this.routerMode === "deterministic") return fallback();
    const useGrok = this.routerMode === "grok" || grokAvailable(this.config.grokBin);
    if (!useGrok) return fallback();
    try {
      return await planWithGrok({
        bin: this.config.grokBin,
        workers: this.config.workers,
        userText: message,
      });
    } catch (error) {
      if (this.routerMode === "grok") throw error;
      const reason = error instanceof Error ? error.message : String(error);
      this.out(`orchestrator> planner failed; using deterministic router (${reason})`);
      return fallback();
    }
  }
}
