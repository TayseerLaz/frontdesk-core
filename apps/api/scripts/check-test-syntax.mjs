// Parse every test file and fail on syntax errors.
//
// Why this exists: on 2026-08-03 a hard-gate test file reached main with five string
// literals split across real newlines. `pnpm typecheck` was clean because tsconfig.json
// excludes test/, and vitest cannot boot on a developer machine (its global setup imports
// env.ts, which process.exit(1)s), so nothing local ever read the file. CI caught it only
// at the transform step, after the push.
//
// This is the cheap check that closes that gap. It does not type-check — it proves every
// test file can be PARSED, which is the failure mode that actually bit us. Uses the
// TypeScript compiler's own parser: typescript is a direct dependency, whereas esbuild and
// vite arrive transitively under vitest and pnpm's strict node_modules does not hoist them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = path.resolve(import.meta.dirname, '..', 'test');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

let failed = 0;
const files = walk(ROOT);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // parseDiagnostics is internal but stable, and is the only way to get syntax-only
  // errors without building a full Program (which would drag in every import).
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length === 0) continue;

  failed += 1;
  const rel = path.relative(process.cwd(), file);
  for (const d of diags.slice(0, 5)) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    console.error(`PARSE FAIL  ${rel}:${line + 1}:${character + 1}  ${msg}`);
  }
}

console.log(
  failed === 0
    ? `✓ all ${files.length} test files parse`
    : `✗ ${failed} of ${files.length} test files failed to parse`,
);
process.exit(failed === 0 ? 0 : 1);
