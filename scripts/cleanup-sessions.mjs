#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const MIMO_BIN = `${homedir()}/Documentos/YouTube/mimo/sandbox/bin/mimo`;
const HOURS = parseInt(process.argv[2] || "5", 10);
const CUTOFF = Date.now() - HOURS * 3_600_000;

if (!existsSync(MIMO_BIN)) {
  console.error(`mimo binary not found at ${MIMO_BIN}`);
  process.exit(1);
}

function run(args) {
  return execSync(`"${MIMO_BIN}" ${args}`, { encoding: "utf8", timeout: 30000 });
}

// Fetch sessions as TSV via `mimo db` (read-only)
const raw = run(`db "SELECT id, time_updated FROM session WHERE time_updated < ${CUTOFF} ORDER BY time_updated ASC;"`);
const lines = raw.trim().split("\n").slice(1); // skip header

if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
  console.log("No stale sessions found.");
  process.exit(0);
}

console.log(`Found ${lines.length} sessions not used in >${HOURS}h:\n`);

for (const line of lines) {
  const [id, updated] = line.split("\t");
  if (!id) continue;
  const ageH = ((Date.now() - parseInt(updated, 10)) / 3_600_000).toFixed(1);
  console.log(`  ${id}  (${ageH}h stale)`);
}

console.log(`\nDeleting ${lines.length} sessions...`);
for (const line of lines) {
  const [id] = line.split("\t");
  if (!id) continue;
  try {
    run(`session delete ${id}`);
    process.stdout.write(".");
  } catch {
    process.stdout.write("x");
  }
}
console.log("\nDone.");
