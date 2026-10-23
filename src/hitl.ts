import type { Hitl, HitlDecision, PermissionOption, PermissionPrompt } from "./types.js";

export interface PermissionOutcome {
  outcome: "selected" | "cancelled";
  optionId?: string;
}

const ALLOW_KIND_ORDER = ["allow_once", "allow_always"];
const DENY_KIND_ORDER = ["reject_once", "reject_always"];

/**
 * Map a human decision onto an ACP `session/request_permission` outcome.
 * Allow prefers `allow_once` over `allow_always`. Deny prefers `reject_once`.
 * Cancel, or a deny with no reject option, returns `cancelled`.
 */
export function selectPermissionOption(
  options: PermissionOption[],
  decision: HitlDecision,
): PermissionOutcome {
  if (decision === "cancel" || options.length === 0) {
    return { outcome: "cancelled" };
  }
  const order = decision === "allow" ? ALLOW_KIND_ORDER : DENY_KIND_ORDER;
  for (const kind of order) {
    const match = options.find((option) => option.kind === kind);
    if (match) return { outcome: "selected", optionId: match.optionId };
  }
  if (decision === "deny") return { outcome: "cancelled" };
  const fallback = options[0];
  if (!fallback) return { outcome: "cancelled" };
  return { outcome: "selected", optionId: fallback.optionId };
}

export function decisionLabel(decision: HitlDecision): string {
  if (decision === "allow") return "allow once";
  if (decision === "deny") return "deny";
  return "cancel";
}

function parseAnswer(answer: string): HitlDecision {
  const text = answer.trim().toLowerCase();
  if (text === "a" || text === "allow" || text === "y" || text === "yes") return "allow";
  if (text === "d" || text === "deny" || text === "n" || text === "no") return "deny";
  if (text === "c" || text === "cancel") return "cancel";
  return "deny";
}

function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length <= 240) return text;
  return `${text.slice(0, 240)}…`;
}

export function createHitl(options: {
  decision: HitlDecision | "ask";
  sourceLabel: string;
  out: (line: string) => void;
  ask?: (question: string) => Promise<string>;
  interactive: boolean;
}): Hitl {
  return {
    async decide(prompt: PermissionPrompt): Promise<HitlDecision> {
      options.out(`hitl> ${prompt.worker}: ${prompt.title}`);
      if (prompt.rawInput !== undefined) {
        options.out(`hitl> input: ${preview(prompt.rawInput)}`);
      }
      const choices = prompt.options.map((option) => `${option.name} (${option.kind})`).join(", ");
      if (choices) options.out(`hitl> options: ${choices}`);

      let decision: HitlDecision;
      let source = options.sourceLabel;
      if (options.decision === "ask") {
        if (!options.interactive || !options.ask) {
          throw new Error(
            "a worker asked for permission, but stdin is not a terminal. Re-run with --hitl allow or --hitl deny.",
          );
        }
        options.out("hitl> [a]llow once  [d]eny  [c]ancel");
        decision = parseAnswer(await options.ask("hitl> "));
        source = "prompt";
      } else {
        decision = options.decision;
      }
      options.out(`hitl> decision: ${decisionLabel(decision)} (${source})`);
      return decision;
    },
  };
}
