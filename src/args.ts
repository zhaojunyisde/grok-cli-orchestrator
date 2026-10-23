import type { AppConfig, HitlDecision } from "./types.js";

export interface CliOptions {
  help: boolean;
  mock: boolean;
  once?: string;
  config?: string;
  hitl: HitlDecision | "ask";
  hitlSource: string;
  router?: AppConfig["router"];
  verbose: boolean;
}

function envMock(): boolean {
  return process.env.MOCK_GROK === "1" || process.env.MOCK_GROK === "true";
}

function envHitl(): { hitl: CliOptions["hitl"]; source: string } {
  const value = process.env.HITL_DECISION;
  if (value === "allow" || value === "deny" || value === "cancel") {
    return { hitl: value, source: "HITL_DECISION" };
  }
  return { hitl: "ask", source: "prompt" };
}

export function parseArgs(argv: string[]): CliOptions {
  const fromEnv = envHitl();
  const opts: CliOptions = {
    help: false,
    mock: envMock(),
    hitl: fromEnv.hitl,
    hitlSource: fromEnv.source,
    verbose: false,
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
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--mock") {
      opts.mock = true;
    } else if (arg === "--verbose") {
      opts.verbose = true;
    } else if (arg === "--once") {
      opts.once = next();
    } else if (arg === "--config") {
      opts.config = next();
    } else if (arg === "--hitl") {
      const value = next();
      if (value !== "allow" && value !== "deny" && value !== "cancel" && value !== "ask") {
        throw new Error("--hitl must be allow, deny, cancel, or ask");
      }
      opts.hitl = value;
      opts.hitlSource = value === "ask" ? "prompt" : `--hitl ${value}`;
    } else if (arg === "--router") {
      const value = next();
      if (value !== "auto" && value !== "grok" && value !== "deterministic") {
        throw new Error("--router must be auto, grok, or deterministic");
      }
      opts.router = value;
    } else {
      throw new Error(`unknown argument: ${arg ?? ""}`);
    }
  }
  return opts;
}

export const HELP = `grok-cli-orchestrator

Talk only to the orchestrator. It routes each message to Grok CLI workers.

Usage
  npm start
  npm start -- --mock
  npm start -- --mock --hitl allow --once "Research ACP, then sketch a health check"

Options
  --mock           Do not spawn grok. Same as MOCK_GROK=1.
  --config <file>  Worker list (YAML or JSON). Default: orchestrator.yaml
  --once <text>    One turn, then exit. Otherwise a REPL, or stdin if piped.
  --hitl <choice>  allow, deny, cancel, or ask (default: ask on a TTY)
  --router <mode>  auto, grok, or deterministic
  --verbose        Print spawn args and worker stderr
  --help           Show this help

Real mode spawns \`grok agent stdio\` per worker and, when grok is on PATH,
plans with \`grok -p --output-format json\`. Auth is \`grok login\` or XAI_API_KEY.

Web UI
  npm run ui            Mock desk at http://127.0.0.1:4173
  npm run ui -- --real  Same desk, spawning grok
  npm run ui:smoke      One mock turn: research, code, and a permission prompt
`;
