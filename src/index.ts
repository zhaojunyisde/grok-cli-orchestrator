import readline from "node:readline/promises";
import { stderr, stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { HELP, parseArgs } from "./args.js";
import { defaultConfigPath, loadConfig } from "./config.js";
import { createHitl } from "./hitl.js";
import { Orchestrator } from "./orchestrator.js";
import { grokAvailable } from "./worker_pool.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    output.write(`${HELP}\n`);
    return;
  }

  const config = loadConfig(opts.config ?? defaultConfigPath());
  if (opts.router) config.router = opts.router;
  if (process.env.GROK_BIN && process.env.GROK_BIN.trim() !== "") {
    config.grokBin = process.env.GROK_BIN.trim();
  }

  if (!opts.mock && !grokAvailable(config.grokBin)) {
    throw new Error(
      `grok binary not found (${config.grokBin}). Install the Grok CLI and run \`grok login\`, or start with --mock.`,
    );
  }

  const shownRouter = opts.mock || config.router === "deterministic" || (config.router === "auto" && !grokAvailable(config.grokBin))
    ? "deterministic"
    : "grok";
  const names = config.workers
    .map((worker) => `${worker.name}${worker.alwaysApprove ? "" : "*"}`)
    .join(",");
  const say = (line: string) => {
    output.write(`${line}\n`);
  };
  say(
    `grok-cli-orchestrator  mode=${opts.mock ? "mock" : "real"}  router=${shownRouter}  workers=${names}`,
  );
  say("workers marked * ask you before tools run.");

  const interactive = Boolean(input.isTTY);
  const needsReader = interactive && (opts.once === undefined || opts.hitl === "ask");
  const reader = needsReader ? readline.createInterface({ input, output }) : undefined;
  const hitl = createHitl({
    decision: opts.hitl,
    sourceLabel: opts.hitlSource,
    out: say,
    interactive,
    ...(reader ? { ask: (question: string) => reader.question(question) } : {}),
  });
  const orchestrator = new Orchestrator(config, hitl, say, {
    mock: opts.mock,
    verbose: opts.verbose,
    ...(opts.router ? { router: opts.router } : {}),
  });

  const stop = () => {
    void orchestrator.close().finally(() => process.exit(130));
  };
  process.once("SIGINT", stop);

  try {
    if (opts.once !== undefined) {
      say(`you> ${opts.once}`);
      await orchestrator.handle(opts.once);
      return;
    }
    if (!interactive) {
      const text = await readStdin();
      if (text.trim() === "") {
        throw new Error("no message on stdin. Pass --once or run in a terminal.");
      }
      say(`you> ${text.trim()}`);
      await orchestrator.handle(text);
      return;
    }
    say("talk to the orchestrator. /help  /workers  /quit");
    say("");
    if (!reader) return;
    for (;;) {
      const line = (await reader.question("you> ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        say("Ask for research, a sketch, or both. /workers lists stations. /quit exits.");
        continue;
      }
      if (line === "/workers") {
        for (const worker of config.workers) {
          const gate = worker.alwaysApprove ? "always-approve" : "ask";
          say(`${worker.name}  ${gate}  cwd=${worker.cwd}`);
        }
        continue;
      }
      try {
        await orchestrator.handle(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        say(`orchestrator> ${message}`);
      }
      say("");
    }
  } finally {
    process.off("SIGINT", stop);
    await orchestrator.close();
    reader?.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (import.meta.url === pathToFileURL(entry).href) return true;
  return entry.endsWith("/src/index.ts") || entry.endsWith("/src/index.js");
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`orchestrator> ${message}\n`);
    process.exitCode = 1;
  });
}
