import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/args.js";
import { loadConfig } from "../src/config.js";
import { createHitl, selectPermissionOption } from "../src/hitl.js";
import { Orchestrator } from "../src/orchestrator.js";
import {
  buildPlannerArgs,
  deterministicPlan,
  parseHeadlessStdout,
  parsePlan,
  PLANNER_RULES,
} from "../src/router.js";
import type { AppConfig, HitlDecision } from "../src/types.js";
import {
  agentProfileValue,
  buildGrokAgentArgs,
  buildSessionNewParams,
  grokAvailable,
} from "../src/worker_pool.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const MESSAGE =
  "Research how ACP permission requests work, then sketch a tiny shell health check. Writing the file needs approval.";

function shippedConfig(): AppConfig {
  return loadConfig(path.join(root, "orchestrator.yaml"));
}

test("parseArgs honors --mock and --hitl", () => {
  const opts = parseArgs(["--mock", "--hitl", "deny", "--once", "hello"]);
  assert.equal(opts.mock, true);
  assert.equal(opts.hitl, "deny");
  assert.equal(opts.hitlSource, "--hitl deny");
  assert.equal(opts.once, "hello");
  assert.throws(() => parseArgs(["--hitl", "maybe"]), /--hitl must be/);
});

test("createHitl can take a browser decider without a TTY", async () => {
  const lines: string[] = [];
  const hitl = createHitl({
    decision: "ask",
    sourceLabel: "ui",
    out: (line) => lines.push(line),
    interactive: false,
    decideAsync: async () => "deny",
  });
  const decision = await hitl.decide({
    worker: "coder",
    title: "Write file",
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
  });
  assert.equal(decision, "deny");
  const text = lines.join("\n");
  assert.match(text, /hitl> coder: Write file/);
  assert.match(text, /decision: deny \(ui\)/);
  assert.doesNotMatch(text, /\[a\]llow once/);
});

test("selectPermissionOption prefers allow_once and reject_once", () => {
  const options = [
    { optionId: "allow-always", name: "Always", kind: "allow_always" },
    { optionId: "allow-once", name: "Once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
  assert.deepEqual(selectPermissionOption(options, "allow"), {
    outcome: "selected",
    optionId: "allow-once",
  });
  assert.deepEqual(selectPermissionOption(options, "deny"), {
    outcome: "selected",
    optionId: "reject-once",
  });
  assert.deepEqual(selectPermissionOption(options, "cancel"), { outcome: "cancelled" });
});

test("deterministic router orders research before code", () => {
  const names = ["researcher", "coder"];
  assert.deepEqual(
    deterministicPlan(MESSAGE, names).map((step) => step.worker),
    ["researcher", "coder"],
  );
  assert.deepEqual(
    deterministicPlan("sketch a script", names).map((step) => step.worker),
    ["coder"],
  );
  assert.deepEqual(
    deterministicPlan("hello there", names).map((step) => step.worker),
    ["researcher"],
  );
  assert.deepEqual(
    deterministicPlan("Research the bug, sketch a fix, and review the patch", [
      "researcher",
      "coder",
      "reviewer",
    ]).map((step) => step.worker),
    ["researcher", "coder", "reviewer"],
  );
});

test("planner args stay on documented grok -p flags", () => {
  const args = buildPlannerArgs("plan this");
  assert.deepEqual(args.slice(0, 2), ["--no-auto-update", "-p"]);
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("json"));
  assert.ok(args.includes("--always-approve"));
  assert.ok(args.includes("--max-turns"));
  assert.ok(args.includes("--rules"));
  assert.ok(args.includes(PLANNER_RULES));
  assert.equal(args.filter((arg) => arg.startsWith("--")).length, 5);
});

test("headless JSON parser reads text and surfaces errors", () => {
  const parsed = parseHeadlessStdout(
    JSON.stringify({ text: '{"steps":[]}', stopReason: "end_turn", sessionId: "s1" }),
  );
  assert.equal(parsed.sessionId, "s1");
  assert.equal(parsePlan('{"steps":[{"worker":"coder","task":"ship it"}]}', ["coder"])?.[0]?.worker, "coder");
  assert.equal(parsePlan('{"steps":[{"worker":"nope","task":"x"}]}', ["coder"]), null);
  assert.throws(
    () => parseHeadlessStdout(JSON.stringify({ type: "error", message: "no auth" })),
    /no auth/,
  );
});

test("worker spawn args and session meta match the ACP contract", () => {
  const config = shippedConfig();
  const coder = config.workers.find((worker) => worker.name === "coder");
  const researcher = config.workers.find((worker) => worker.name === "researcher");
  assert.ok(coder && researcher);
  assert.deepEqual(buildGrokAgentArgs(coder), [
    "--no-auto-update",
    "agent",
    "--agent-profile",
    coder.profileFile,
    "stdio",
  ]);
  const researcherArgs = buildGrokAgentArgs(researcher);
  assert.equal(researcherArgs.at(-1), "stdio");
  assert.ok(researcherArgs.includes("--always-approve"));
  assert.equal(researcherArgs.indexOf("--always-approve") < researcherArgs.indexOf("stdio"), true);
  const params = buildSessionNewParams(coder);
  assert.equal(params.cwd, coder.cwd);
  assert.deepEqual(params.mcpServers, []);
  assert.equal(params._meta.yoloMode, false);
  assert.equal(params._meta.agentProfile, "coder");
  assert.match(String(params._meta.rules), /Persona: coder/);
  assert.deepEqual(agentProfileValue('{"name":"coder"}'), { name: "coder" });
});

test("shipped config loads researcher and coder", () => {
  const config = shippedConfig();
  assert.deepEqual(
    config.workers.map((worker) => worker.name),
    ["researcher", "coder"],
  );
  assert.equal(config.workers[0]?.alwaysApprove, true);
  assert.equal(config.workers[1]?.alwaysApprove, false);
  assert.equal(config.router, "auto");
});

async function runTurn(
  config: AppConfig,
  decision: HitlDecision,
  message = MESSAGE,
): Promise<string[]> {
  const lines: string[] = [];
  const hitl = createHitl({
    decision,
    sourceLabel: `--hitl ${decision}`,
    out: (line) => lines.push(line),
    interactive: false,
  });
  const orchestrator = new Orchestrator(config, hitl, (line) => lines.push(line), {
    mock: true,
    verbose: false,
  });
  try {
    await orchestrator.handle(message);
  } finally {
    await orchestrator.close();
  }
  return lines;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const result = spawnSync(tsx, ["src/index.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("mock ACP path allows a coder write after HITL", async () => {
  const lines = await runTurn(shippedConfig(), "allow");
  const text = lines.join("\n");
  assert.match(text, /plan \(deterministic\): researcher -> coder/);
  assert.match(text, /session\/request_permission/);
  assert.match(text, /hitl> decision: allow once \(--hitl allow\)/);
  assert.match(text, /Approved write of scripts\/healthcheck\.sh/);
  assert.match(text, /finished 2 steps\./);
});

test("mock ACP path records a deny and does not pretend the file was written", async () => {
  const lines = await runTurn(shippedConfig(), "deny");
  const text = lines.join("\n");
  assert.match(text, /plan \(deterministic\): researcher -> coder/);
  assert.match(text, /hitl> decision: deny \(--hitl deny\)/);
  assert.match(text, /human denied the tool call/);
  assert.doesNotMatch(text, /Approved write/);
  assert.match(text, /finished 2 steps\./);
});

test("mock ACP path records a cancel and stops the write", async () => {
  const lines = await runTurn(shippedConfig(), "cancel");
  const text = lines.join("\n");
  assert.match(text, /hitl> decision: cancel \(--hitl cancel\)/);
  assert.match(text, /human cancelled the tool call/);
  assert.doesNotMatch(text, /Approved write/);
  assert.match(text, /finished 2 steps\./);
});

test("mock plan runs researcher, coder, and reviewer", async () => {
  const config = shippedConfig();
  const home = config.workers[0];
  assert.ok(home);
  config.workers.push({
    name: "reviewer",
    profile: "reviewer",
    rules: "Persona: reviewer\nReview the earlier notes. Do not edit files.",
    cwd: home.cwd,
    alwaysApprove: true,
  });
  const lines = await runTurn(
    config,
    "allow",
    "Research the ACP flow, sketch a handler, and review the patch.",
  );
  const text = lines.join("\n");
  assert.match(text, /plan \(deterministic\): researcher -> coder -> reviewer/);
  assert.match(text, /Approved write of scripts\/healthcheck\.sh/);
  assert.match(text, /Mock reviewer received/);
  assert.match(text, /finished 3 steps\./);
});

test("always-approve coder does not raise HITL", async () => {
  const config = shippedConfig();
  const coder = config.workers.find((worker) => worker.name === "coder");
  assert.ok(coder);
  coder.alwaysApprove = true;
  const lines = await runTurn(config, "allow");
  const text = lines.join("\n");
  assert.doesNotMatch(text, /hitl>/);
  assert.match(text, /no permission prompt was raised/);
});

test("cli mock scenario exits 0", () => {
  const result = runCli(["--mock", "--hitl", "allow", "--once", MESSAGE]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /mode=mock/);
  assert.match(result.stdout, /finished 2 steps\./);
});

test("cli mock deny and cancel exit 0 without approving the write", () => {
  const deny = runCli(["--mock", "--hitl", "deny", "--once", MESSAGE]);
  assert.equal(deny.status, 0, deny.stderr);
  assert.match(deny.stdout, /decision: deny/);
  assert.match(deny.stdout, /human denied the tool call/);
  assert.doesNotMatch(deny.stdout, /Approved write/);

  const cancel = runCli(["--mock", "--hitl", "cancel", "--once", MESSAGE]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /decision: cancel/);
  assert.match(cancel.stdout, /human cancelled the tool call/);
  assert.doesNotMatch(cancel.stdout, /Approved write/);
});

test("missing grok binary exits 1 unless mock mode is on", () => {
  assert.equal(grokAvailable("/no/such/grok-bin"), false);
  const missing = runCli(["--once", "hello"], { GROK_BIN: "/no/such/grok-bin" });
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stderr, /grok binary not found \(\/no\/such\/grok-bin\)/);
  assert.doesNotMatch(missing.stdout, /mode=real/);

  const mocked = runCli(["--mock", "--hitl", "allow", "--once", "hello"], {
    GROK_BIN: "/no/such/grok-bin",
  });
  assert.equal(mocked.status, 0, mocked.stderr);
  assert.match(mocked.stdout, /mode=mock/);
  assert.match(mocked.stdout, /finished 1 step\./);
});
