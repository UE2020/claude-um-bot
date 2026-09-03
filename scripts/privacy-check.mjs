#!/usr/bin/env node
// Pre-push safety check. It examines every tracked or non-ignored untracked
// file (the set `git add -A` could stage), without printing secret values.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (args, options = {}) => execFileSync("git", args, { cwd: root, encoding: "utf8", ...options });

const candidates = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  .split("\0")
  .filter(Boolean);

const privatePathRules = [
  { label: "database", pattern: /(^|\/)mafia\.db(?:-|$)/i },
  { label: "live config", pattern: /(^|\/)config\.json$/i },
  { label: "environment file", pattern: /(^|\/)\.env(?:\.|$)/i, allow: /(^|\/)\.env\.example$/i },
  { label: "generated dataset", pattern: /^data\/.*\.(?:jsonl|zip)$/i },
  { label: "model weights", pattern: /\.(?:gguf|safetensors)$/i },
];

const textRules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["authorization bearer token", /authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
  ["OpenAI-style API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["UltiMafia session cookie", /connect\.sid=(?!<|\.{3})[^\s"']{12,}/i],
];

const failures = [];
for (const relative of candidates) {
  const normalized = relative.replaceAll("\\", "/");
  for (const rule of privatePathRules) {
    if (rule.pattern.test(normalized) && !(rule.allow?.test(normalized))) {
      failures.push(`${normalized}: ${rule.label} must remain ignored`);
    }
  }

  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) continue;
  const source = buffer.toString("utf8");
  for (const [label, pattern] of textRules) {
    if (pattern.test(source)) failures.push(`${normalized}: possible ${label}`);
  }
}

const mustBeIgnored = [
  "mafia.db",
  "mafia.db-shm",
  "mafia.db-wal",
  "config.json",
  ".env",
  "data/train.jsonl",
  "data/eval.jsonl",
  "data/um-dataset.zip",
  "training-output/checkpoints/model.safetensors",
];
for (const relative of mustBeIgnored) {
  try {
    git(["check-ignore", "--quiet", "--no-index", "--", relative]);
  } catch {
    failures.push(`${relative}: expected an ignore rule, but none matched`);
  }
}

if (failures.length) {
  console.error("Privacy check failed:");
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  console.error("No matching secret values were printed.");
  process.exit(1);
}

console.log(`Privacy check passed: ${candidates.length} publishable files scanned; private artifacts are ignored.`);
