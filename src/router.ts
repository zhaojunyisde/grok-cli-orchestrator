import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Plan, PlanStep, WorkerConfig } from "./types.js";

const execFileAsync = promisify(execFile);

const RESEARCH_WORDS = [
  "research",
  "explain",
  "how",
  "what",
  "why",
  "compare",
  "permission",
  "summarize",
  "acp",
];
const CODE_WORDS = [
  "code",
  "implement",
  "write",
  "writing",
  "sketch",
  "script",
  "fix",
  "build",
  "handler",
  "patch",
  "function",
];
const REVIEW_WORDS = ["review", "audit"];

const TASKS: Record<string, string> = {
  researcher: "Summarize the facts and constraints. Do not edit files.",
  coder: "Sketch the smallest implementation, including the concrete snippet or file.",
  reviewer: "Review the earlier notes for risks and gaps. Do not edit files.",
};

export const PLANNER_RULES =
  "You are a router. Output one JSON object and nothing else. Do not call tools. Do not solve the user task.";

function hasWord(text: string, words: string[]): boolean {
  return words.some((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
}

export function deterministicPlan(message: string, workerNames: string[]): PlanStep[] {
  const known = new Set(workerNames);
  const steps: PlanStep[] = [];
  const push = (name: string) => {
    if (!known.has(name) || steps.some((step) => step.worker === name)) return;
    steps.push({
      worker: name,
      task: TASKS[name] ?? "Handle the delegated task within your role.",
    });
  };
  if (hasWord(message, RESEARCH_WORDS)) push("researcher");
  if (hasWord(message, CODE_WORDS)) push("coder");
  if (hasWord(message, REVIEW_WORDS)) push("reviewer");
  if (steps.length === 0 && workerNames[0]) {
    push(workerNames[0]);
  }
  return steps;
}

export function roleHint(rules: string): string {
  const lines = rules
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("Persona:"));
  return (lines[0] ?? "specialist").slice(0, 160);
}

export function plannerPrompt(workers: WorkerConfig[], userText: string): string {
  const list = workers.map((worker) => `- ${worker.name}: ${roleHint(worker.rules)}`).join("\n");
  return [
    "Choose which workers should handle the user message.",
    "Reply with only this JSON shape:",
    '{"steps":[{"worker":"<name>","task":"<instruction for that worker>"}]}',
    "Use only the listed worker names. Use one to three steps, in the order they should run.",
    "",
    "Workers:",
    list,
    "",
    "User message:",
    userText,
  ].join("\n");
}

/**
 * Args for a one-shot planner. Flags are the documented headless set:
 * `--no-auto-update`, `-p`, `--output-format json`, `--always-approve`,
 * `--max-turns`, `--rules`.
 */
export function buildPlannerArgs(prompt: string): string[] {
  return [
    "--no-auto-update",
    "-p",
    prompt,
    "--output-format",
    "json",
    "--always-approve",
    "--max-turns",
    "1",
    "--rules",
    PLANNER_RULES,
  ];
}

export function parseHeadlessStdout(stdout: string): { text: string; sessionId?: string } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("grok -p returned empty stdout");
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split("\n").filter((line) => line.trim().startsWith("{"));
    const last = lines[lines.length - 1];
    if (!last) {
      throw new Error(`grok -p did not return JSON: ${trimmed.slice(0, 300)}`);
    }
    data = JSON.parse(last);
  }
  if (typeof data !== "object" || data === null) {
    throw new Error("grok -p JSON was not an object");
  }
  const record = data as { type?: unknown; message?: unknown; text?: unknown; sessionId?: unknown };
  if (record.type === "error") {
    throw new Error(typeof record.message === "string" ? record.message : "grok -p failed");
  }
  if (typeof record.text !== "string") {
    throw new Error("grok -p JSON had no text field");
  }
  return {
    text: record.text,
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
  };
}

export function parsePlan(text: string, workerNames: string[]): PlanStep[] | null {
  const fenced = text.replace(/```(?:json)?/gi, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || !Array.isArray((data as { steps?: unknown }).steps)) {
    return null;
  }
  const known = new Set(workerNames);
  const steps: PlanStep[] = [];
  for (const step of (data as { steps: unknown[] }).steps) {
    if (typeof step !== "object" || step === null) return null;
    const worker = (step as { worker?: unknown }).worker;
    const task = (step as { task?: unknown }).task;
    if (typeof worker !== "string" || !known.has(worker)) return null;
    steps.push({
      worker,
      task: typeof task === "string" && task.trim() !== "" ? task.trim() : "Handle the user request.",
    });
  }
  if (steps.length === 0) return null;
  return steps.slice(0, 3);
}

export async function planWithGrok(options: {
  bin: string;
  workers: WorkerConfig[];
  userText: string;
  timeoutMs?: number;
}): Promise<Plan> {
  const prompt = plannerPrompt(options.workers, options.userText);
  const args = buildPlannerArgs(prompt);
  let stdout = "";
  try {
    const result = await execFileAsync(options.bin, args, {
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    stdout = result.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === "ENOENT") {
      throw new Error(`Could not spawn ${options.bin}. Install the Grok CLI or rerun with --mock.`);
    }
    const headless = typeof err.stdout === "string" ? err.stdout : "";
    const detail = typeof err.stderr === "string" ? err.stderr.trim() : "";
    if (headless.trim()) {
      try {
        const parsed = parseHeadlessStdout(headless);
        const steps = parsePlan(parsed.text, options.workers.map((worker) => worker.name));
        if (steps) return { source: "grok", steps };
      } catch {
        // Fall through to the spawn error.
      }
    }
    const message = detail || err.message;
    throw new Error(`grok -p failed: ${message.slice(0, 500)}`);
  }
  const parsed = parseHeadlessStdout(stdout);
  const steps = parsePlan(parsed.text, options.workers.map((worker) => worker.name));
  if (!steps) {
    throw new Error(`grok -p did not return a worker plan: ${parsed.text.slice(0, 300)}`);
  }
  return { source: "grok", steps };
}
