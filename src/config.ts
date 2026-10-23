import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AppConfig, WorkerConfig } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function workerFrom(raw: unknown, index: number, configDir: string): WorkerConfig {
  if (!isRecord(raw)) {
    throw new Error(`workers[${index}] must be a mapping`);
  }
  const name = requiredString(raw.name, `workers[${index}].name`);
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      `workers[${index}].name must be lowercase and start with a letter (got ${name})`,
    );
  }
  const rules = requiredString(raw.rules, `workers[${index}].rules`);
  const cwdRaw = typeof raw.cwd === "string" && raw.cwd.trim() !== "" ? raw.cwd : ".";
  const profile =
    typeof raw.profile === "string" && raw.profile.trim() !== "" ? raw.profile.trim() : undefined;
  const profileFile =
    typeof raw.profileFile === "string" && raw.profileFile.trim() !== ""
      ? path.resolve(configDir, raw.profileFile)
      : undefined;
  if (profileFile && !existsSync(profileFile)) {
    throw new Error(`workers[${index}].profileFile does not exist: ${profileFile}`);
  }
  return {
    name,
    rules,
    cwd: path.resolve(configDir, cwdRaw),
    alwaysApprove: raw.alwaysApprove === true,
    ...(profile ? { profile } : {}),
    ...(profileFile ? { profileFile } : {}),
  };
}

export function parseConfig(raw: unknown, configDir: string): AppConfig {
  if (!isRecord(raw)) {
    throw new Error("config must be a mapping");
  }
  if (!Array.isArray(raw.workers) || raw.workers.length === 0) {
    throw new Error("config.workers must be a non-empty list");
  }
  const workers = raw.workers.map((worker, index) => workerFrom(worker, index, configDir));
  const names = new Set<string>();
  for (const worker of workers) {
    if (names.has(worker.name)) {
      throw new Error(`duplicate worker name: ${worker.name}`);
    }
    names.add(worker.name);
  }
  const router = raw.router ?? "auto";
  if (router !== "auto" && router !== "grok" && router !== "deterministic") {
    throw new Error("config.router must be auto, grok, or deterministic");
  }
  const grokBin =
    typeof raw.grokBin === "string" && raw.grokBin.trim() !== "" ? raw.grokBin.trim() : "grok";
  return { grokBin, router, workers };
}

export function loadConfig(filePath: string): AppConfig {
  const abs = path.resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`config not found: ${abs}`);
  }
  const text = readFileSync(abs, "utf8");
  const parsed: unknown = abs.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return parseConfig(parsed, path.dirname(abs));
}

export function defaultConfigPath(): string {
  const fromCwd = path.resolve(process.cwd(), "orchestrator.yaml");
  if (existsSync(fromCwd)) return fromCwd;
  return fileURLToPath(new URL("../orchestrator.yaml", import.meta.url));
}
