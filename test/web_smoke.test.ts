import { test } from "node:test";
import { runMockUiSmoke } from "../src/web_smoke.js";

test("web ui mock turn routes research then code and shows HITL", { timeout: 20_000 }, async () => {
  await runMockUiSmoke({ quiet: true, decision: "allow" });
});

test("web ui deny and cancel stay on the coder session", { timeout: 20_000 }, async () => {
  await runMockUiSmoke({ quiet: true, decision: "deny" });
  await runMockUiSmoke({ quiet: true, decision: "cancel" });
});
