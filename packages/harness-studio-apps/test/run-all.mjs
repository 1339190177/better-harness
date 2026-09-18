#!/usr/bin/env node
/**
 * Serial runner for the smoke tests in this directory — each one is a
 * standalone script that spawns its app's backend on its own port and prints
 * its own report, so serial execution is the only cross-test requirement.
 *
 * Run: node test/run-all.mjs
 *      (or from the repo root: npm test -w @qoder-ai/harness-studio-apps)
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tests = readdirSync(here)
  .filter((file) => /^test_.*\.mjs$/.test(file))
  .sort()

if (tests.length === 0) {
  process.stderr.write('no test_*.mjs files found next to this runner\n')
  process.exit(1)
}

const started = Date.now()
const failed = []
for (const test of tests) {
  const label = test.replace(/\.mjs$/, '')
  process.stdout.write(`\n=== ${label} ===\n`)
  const result = spawnSync(process.execPath, [join(here, test)], { stdio: 'inherit' })
  if (result.status !== 0) failed.push(`${label} (exit ${result.status ?? 'signal'})`)
}

const seconds = Math.round((Date.now() - started) / 1000)
process.stdout.write(`\n=== summary: ${tests.length} files, ${failed.length} failed, ${seconds}s ===\n`)
for (const entry of failed) process.stdout.write(`  FAIL ${entry}\n`)
process.exit(failed.length ? 1 : 0)
