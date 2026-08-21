#!/usr/bin/env node
/**
 * check-env — the template and the validator must agree.
 *
 * `src/config/env.ts` is the only place the app reads `process.env`, and
 * `scripts/env.example` is what a human copies into `.env`. If one grows a
 * variable the other does not know about, the failure is silent: the app falls
 * back to mock and looks like it is working. This makes that a build failure.
 *
 * Node only, no dependencies — it parses both files as text on purpose, because
 * importing `env.ts` would need a TypeScript runtime and would read the ambient
 * environment rather than the declarations.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => readFileSync(join(root, relative), 'utf8');

/** Every `process.env.EXPO_PUBLIC_*` the config module actually reads. */
function keysReadByConfig(source) {
  return new Set(
    [...source.matchAll(/process\.env\.(EXPO_PUBLIC_[A-Z0-9_]+)/g)].map((m) => m[1]),
  );
}

/** Every `EXPO_PUBLIC_*` assignment in the template (comments ignored). */
function keysInTemplate(source) {
  const keys = new Set();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)\s*=/.exec(trimmed);
    if (match && match[1].startsWith('EXPO_PUBLIC_')) keys.add(match[1]);
  }
  return keys;
}

/** Secrets must never carry the public prefix — it inlines them into the bundle. */
const SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'AUTOMATIONS_SECRET',
  'SERVICE_ROLE',
];

function main() {
  const configSource = read('src/config/env.ts');
  const templateSource = read('scripts/env.example');

  const configKeys = keysReadByConfig(configSource);
  const templateKeys = keysInTemplate(templateSource);

  const problems = [];

  for (const key of configKeys) {
    if (!templateKeys.has(key)) {
      problems.push(`src/config/env.ts reads ${key}, but scripts/env.example does not define it.`);
    }
  }
  for (const key of templateKeys) {
    if (!configKeys.has(key)) {
      problems.push(`scripts/env.example defines ${key}, but src/config/env.ts never reads it.`);
    }
  }
  if (configKeys.size === 0) {
    problems.push('src/config/env.ts reads no EXPO_PUBLIC_* variables at all — did the parser break?');
  }

  // A public-prefixed secret is the one mistake in this file that ships a leak.
  for (const secret of SECRET_NAMES) {
    const publicName = `EXPO_PUBLIC_${secret}`;
    if (templateSource.includes(publicName) || configSource.includes(publicName)) {
      problems.push(`${publicName} would be inlined into the app bundle. Secrets must not carry EXPO_PUBLIC_.`);
    }
  }

  // `src/config/env.ts` is the only sanctioned reader (P1 decision 7).
  const strays = [];
  for (const relative of ['app', 'src']) {
    strays.push(...findStrayEnvReads(join(root, relative)));
  }
  for (const stray of strays) problems.push(`process.env read outside src/config/env.ts: ${stray}`);

  console.log(`check-env: ${configKeys.size} public variable(s) declared in src/config/env.ts`);
  for (const key of [...configKeys].sort()) console.log(`  - ${key}`);

  if (problems.length > 0) {
    console.error('\ncheck-env FAILED:');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log('check-env OK: template and validator agree; no public secrets; no stray reads.');
}

function findStrayEnvReads(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (['node_modules', 'dist', '.expo', '__tests__'].includes(entry)) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(full)) continue;
      if (full.replace(/\\/g, '/').endsWith('src/config/env.ts')) continue;
      const source = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/process\.env\./.test(source)) found.push(full.replace(root, '').replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return found;
}

main();
