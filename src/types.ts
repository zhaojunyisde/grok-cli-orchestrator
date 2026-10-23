export interface WorkerConfig {
  /** Router name. Also the label shown to the human. */
  name: string;
  /**
   * Sent as `session/new` `_meta.agentProfile` when set.
   * A string is a profile name. A JSON object string is sent as an object.
   */
  profile?: string;
  /** Markdown file passed to `grok agent --agent-profile`. */
  profileFile?: string;
  /** Sent as `session/new` `_meta.rules`. */
  rules: string;
  /** Absolute working directory passed as `session/new` `cwd`. */
  cwd: string;
  /**
   * When true, the worker is spawned with `--always-approve` and
   * `_meta.yoloMode` is true. When false, tool use can ask the human.
   */
  alwaysApprove: boolean;
}

export interface AppConfig {
  grokBin: string;
  router: "auto" | "grok" | "deterministic";
  workers: WorkerConfig[];
}

export interface PlanStep {
  worker: string;
  task: string;
}

export interface Plan {
  source: "grok" | "deterministic";
  steps: PlanStep[];
}

export type HitlDecision = "allow" | "deny" | "cancel";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionPrompt {
  worker: string;
  title: string;
  toolCallId?: string;
  rawInput?: unknown;
  options: PermissionOption[];
}

export interface Hitl {
  decide(prompt: PermissionPrompt): Promise<HitlDecision>;
}

export interface WorkerTurn {
  name: string;
  text: string;
  stopReason: string;
  decisions: HitlDecision[];
}
