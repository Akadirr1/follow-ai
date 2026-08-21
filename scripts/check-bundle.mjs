#!/usr/bin/env node
/**
 * check-bundle — build the production web bundle and read what is actually in it.
 *
 * Three questions, all of which have been answered wrongly by inspection before:
 *
 * 1. Does the bundle contain a secret? Every `EXPO_PUBLIC_*` value is inlined at
 *    build time, so a mis-prefixed key is not a lint problem — it is a published
 *    credential. Grepping the source cannot see a value that arrives from the
 *    environment; grepping the artefact can.
 * 2. Does the Supabase adapter actually ship? P6 measured that it did **not**:
 *    nothing imported `getRepositories()` yet, so Metro tree-shook the whole data
 *    layer out while the export still exited 0. A green export is not evidence
 *    that the app can reach the backend.
 * 3. Is the embedded Supabase JWT the *anon* one? The service-role key is also a
 *    JWT, so a substring scan cannot tell them apart — the payload has to be
 *    decoded. This is the leak that would matter most and the one a plain grep
 *    misses entirely.
 * 4. Did the URL and anon key actually get inlined? **Measured 2026-08-21:**
 *    without `--clear`, Metro reuses a cached transform built before the
 *    `EXPO_PUBLIC_*` values were set, so they are silently absent, `resolveEnv`
 *    falls back to mock, and a production build ships prototype data while every
 *    other check stays green. Hence the `--clear` below and the presence
 *    assertion — a cached build must never pass this gate.
 *
 * Node only, no dependencies. Runs `expo export` itself so the artefact under
 * test is the one this script built.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

/**
 * The tokens the release gate scans for.
 *
 * `credential` is what an actual leaked value looks like — a bare token in
 * library code is not a secret, a token followed by key material is. Every hit
 * that is not credential-shaped must match `known`, an explicitly justified
 * occurrence; anything else fails so a new hit is investigated rather than
 * absorbed.
 */
const FORBIDDEN = [
  {
    token: 'sk-ant',
    credential: /sk-ant-[A-Za-z0-9_-]{10,}/,
    known: [],
  },
  {
    token: 'service_role',
    credential: /service_role["'\s]*[:=]["'\s]*[A-Za-z0-9._-]{20,}/,
    known: [
      {
        // supabase-js inspects the JWT role of whatever key it was handed.
        why: 'supabase-js role comparison, no value attached',
        context: /role[^"']{0,20}["']service_role["']|["']service_role["']\s*[,)\]}=;]/,
      },
    ],
  },
  {
    token: 'sb_secret',
    credential: /sb_secret_[A-Za-z0-9_-]{8,}/,
    known: [
      {
        // `key.startsWith("sb_secret_")` — the library's key-format detector.
        why: 'supabase-js key-format prefix check, a literal not a value',
        context: /startsWith\(["']sb_secret_["']\)|["']sb_secret_["']\s*[,)\]}]/,
      },
    ],
  },
  { token: 'SUPABASE_SERVICE_ROLE_KEY', credential: /SUPABASE_SERVICE_ROLE_KEY/, known: [] },
  { token: 'AUTOMATIONS_SECRET', credential: /AUTOMATIONS_SECRET/, known: [] },
];

/**
 * Proof the Supabase read path is in the graph. The view name is a string only
 * `src/data-access/supabase/client.ts` produces, so its presence means the
 * adapter survived tree-shaking.
 */
const REQUIRED = ['aigundem_feed_articles_v1'];

/** Roles that must never appear in a client bundle's embedded JWTs. */
const FORBIDDEN_JWT_ROLES = ['service_role', 'supabase_admin'];

const argv = process.argv.slice(2);
const skipExport = argv.includes('--no-export');
/**
 * `--mode=mock` builds and checks the *dev/test* bundle instead. Its assertions
 * are the mirror image: a mock build must not carry the project's URL or key at
 * all, so shipping one by accident cannot quietly talk to production.
 */
const mode = argv.includes('--mode=mock') ? 'mock' : 'supabase';

/** What the export was told to inline, so the scan can confirm it landed. */
let expectedConfig = { url: null, anonKey: null };

const mask = (value) =>
  value && value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : '(short)';

function readEnvExample() {
  const values = {};
  for (const line of readFileSync(join(root, 'scripts', 'env.example'), 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

function exportProductionBundle() {
  const template = readEnvExample();
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? template.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? template.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  expectedConfig = { url, anonKey };

  if (!url || !anonKey) {
    console.error(
      'check-bundle FAILED: no Supabase URL/anon key available (set them in the environment or scripts/env.example).',
    );
    process.exit(1);
  }

  console.log(`check-bundle: exporting the ${mode} web bundle…`);
  rmSync(dist, { recursive: true, force: true });
  // `shell: true` because on Windows `npx` is a .cmd shim that cannot be spawned
  // directly; the command is a fixed literal, so nothing is interpolated into it.
  const result = spawnSync('npx expo export --platform web --clear', {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env:
      mode === 'mock'
        ? {
            ...process.env,
            EXPO_PUBLIC_DATA_MODE: 'mock',
            EXPO_PUBLIC_SUPABASE_URL: '',
            EXPO_PUBLIC_SUPABASE_ANON_KEY: '',
          }
        : {
            ...process.env,
            EXPO_PUBLIC_DATA_MODE: 'supabase',
            EXPO_PUBLIC_SUPABASE_URL: url,
            EXPO_PUBLIC_SUPABASE_ANON_KEY: anonKey,
          },
  });
  if (result.status !== 0) {
    console.error(`check-bundle FAILED: expo export exited ${result.status}.`);
    process.exit(1);
  }
}

function bundleFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  return files;
}

const TEXT = /\.(js|html|json|map|css|txt)$/i;
const CONTEXT = 120;

/** Every occurrence of `token`, with the surrounding text for judgement. */
function occurrences(contents, token) {
  const hits = [];
  let from = 0;
  for (;;) {
    const at = contents.indexOf(token, from);
    if (at === -1) break;
    hits.push({
      at,
      context: contents.slice(Math.max(0, at - CONTEXT), at + token.length + CONTEXT),
    });
    from = at + token.length;
  }
  return hits;
}

/** Decode any JWT-shaped strings and report their `role` claim. */
function embeddedJwtRoles(contents) {
  const roles = [];
  for (const match of contents.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'));
      roles.push({ role: payload.role ?? '(none)', ref: payload.ref ?? '(none)' });
    } catch {
      // Not a JWT after all; the shape matched but the payload is not JSON.
    }
  }
  return roles;
}

function main() {
  if (!skipExport) exportProductionBundle();

  if (!existsSync(dist)) {
    console.error('check-bundle FAILED: dist/ does not exist.');
    process.exit(1);
  }

  const files = bundleFiles(dist);
  const textFiles = files.filter((f) => TEXT.test(f));
  console.log(`\ncheck-bundle: scanning ${textFiles.length} text file(s) of ${files.length} in dist/`);

  const problems = [];
  const jwtRoles = [];

  for (const rule of FORBIDDEN) {
    let credentialHits = 0;
    let knownHits = 0;
    let unknownHits = 0;

    for (const file of textFiles) {
      const contents = readFileSync(file, 'utf8');
      const short = file.replace(root, '').replace(/\\/g, '/');
      for (const hit of occurrences(contents, rule.token)) {
        if (rule.credential.test(hit.context)) {
          credentialHits += 1;
          problems.push(`LEAK: credential-shaped "${rule.token}" in ${short}`);
          continue;
        }
        const known = rule.known.find((k) => k.context.test(hit.context));
        if (known) {
          knownHits += 1;
          continue;
        }
        unknownHits += 1;
        problems.push(
          `UNKNOWN occurrence of "${rule.token}" in ${short} — not credential-shaped and not on the allowlist. Context:\n      …${hit.context.replace(/\s+/g, ' ').slice(0, 200)}…`,
        );
      }
    }

    const total = credentialHits + knownHits + unknownHits;
    const verdict = credentialHits || unknownHits ? 'FAIL' : 'ok  ';
    const detail =
      total === 0
        ? '0 hit(s)'
        : `${total} hit(s): ${credentialHits} credential-shaped, ${knownHits} known-benign, ${unknownHits} unknown`;
    console.log(`  ${verdict}  forbidden "${rule.token}": ${detail}`);
    if (knownHits > 0) {
      for (const known of rule.known) console.log(`          allowlisted: ${known.why}`);
    }
  }

  const present = new Set();
  for (const file of textFiles) {
    const contents = readFileSync(file, 'utf8');
    for (const needle of REQUIRED) if (contents.includes(needle)) present.add(needle);
    jwtRoles.push(...embeddedJwtRoles(contents));
  }

  for (const needle of REQUIRED) {
    const ok = present.has(needle);
    if (mode === 'mock') {
      // A mock build may still contain the adapter code (it is imported by the
      // factory); what matters is that it carries no credentials — checked below.
      console.log(`  --    "${needle}": ${ok ? 'present' : 'absent'} (not asserted in mock mode)`);
      continue;
    }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  required  "${needle}": ${ok ? 'present' : 'ABSENT'}`);
    if (!ok) {
      problems.push(
        `"${needle}" is absent — the Supabase adapter was tree-shaken out, so this build cannot reach the backend.`,
      );
    }
  }

  // The values the app needs at runtime must actually be in the artefact.
  if (skipExport && !expectedConfig.url) Object.assign(expectedConfig, readEnvExample() && {
    url: readEnvExample().EXPO_PUBLIC_SUPABASE_URL,
    anonKey: readEnvExample().EXPO_PUBLIC_SUPABASE_ANON_KEY,
  });
  for (const [label, value] of [
    ['project URL', expectedConfig.url],
    ['anon key', expectedConfig.anonKey],
  ]) {
    if (!value) continue;
    const found = textFiles.some((f) => readFileSync(f, 'utf8').includes(value));
    if (mode === 'mock') {
      console.log(`  ${found ? 'FAIL' : 'ok  '}  ${label} (${mask(value)}) absent from the mock bundle: ${found ? 'PRESENT' : 'yes'}`);
      if (found) {
        problems.push(
          `the ${label} is inlined into the mock bundle — a dev/test build must carry no project credentials.`,
        );
      }
      continue;
    }
    console.log(`  ${found ? 'ok  ' : 'FAIL'}  inlined  ${label} (${mask(value)}): ${found ? 'present' : 'ABSENT'}`);
    if (!found) {
      problems.push(
        `the ${label} was not inlined — this build would fall back to mock at runtime. A stale Metro cache does this; export with --clear.`,
      );
    }
  }

  const roles = [...new Set(jwtRoles.map((j) => j.role))];
  console.log(`  ${roles.length ? 'ok  ' : '--  '}  embedded JWT role(s): ${roles.join(', ') || '(none)'}`);
  for (const { role } of jwtRoles) {
    if (FORBIDDEN_JWT_ROLES.includes(role)) {
      problems.push(`LEAK: an embedded JWT carries role "${role}" — only the anon key may ship.`);
    }
  }

  if (problems.length > 0) {
    console.error('\ncheck-bundle FAILED:');
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exit(1);
  }
  console.log(
    mode === 'mock'
      ? 'check-bundle OK (mock): no credential leaked, no project config inlined.'
      : 'check-bundle OK (supabase): no credential leaked, Supabase read path present, anon JWT only.',
  );
}

main();
