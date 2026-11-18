// The PHP example, run for real: PHP's own server in front of index.php, the stand-in API
// beside it, and the same run that drives the Express and the Flask example. No network.
//
//   node --test integrations/public-repo/examples/php-invoicing/test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const example = path.join(here, '..')
const stub = path.join(example, '..', '_stub')

// The example needs PHP 8.1 or newer with the curl extension, and nothing else.
const php = spawnSync('php', ['-r', 'exit(PHP_VERSION_ID >= 80100 && function_exists("curl_init") ? 0 : 1);'])
const skip = php.error ? 'php is not on this machine' : php.status !== 0 ? 'php here is older than 8.1 or has no curl extension' : false

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const listening = async (port, name) => {
  for (let i = 0; i < 100; i++) {
    const up = await new Promise((resolve) => {
      const c = connect(port, '127.0.0.1')
      c.once('connect', () => { c.destroy(); resolve(true) })
      c.once('error', () => resolve(false))
    })
    if (up) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${name} did not start on port ${port}`)
}

test('every file of the example is valid PHP', { skip }, () => {
  for (const file of ['billos.php', 'index.php']) {
    const lint = spawnSync('php', ['-l', path.join(example, file)], { encoding: 'utf8' })
    assert.equal(lint.status, 0, lint.stdout + lint.stderr)
  }
})

test('the PHP example issues, replays, settles, credits and checks its webhooks', { skip, timeout: 60_000 }, async () => {
  const [appPort, stubPort] = [await freePort(), await freePort()]
  const logs = []
  const start = (cmd, args, opts) => {
    // Its own process group: PHP's server forks its workers, and stopping only the parent
    // leaves them holding the pipes this test reads.
    const child = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => logs.push(String(d)))
    child.stderr.on('data', (d) => logs.push(String(d)))
    return child
  }
  const api = start(process.execPath, ['server.mjs'], {
    cwd: stub,
    env: { ...process.env, STUB_PORT: String(stubPort), STUB_WEBHOOK_URL: `http://127.0.0.1:${appPort}/webhooks/billos` },
  })
  const app = start('php', ['-S', `127.0.0.1:${appPort}`, 'index.php'], {
    cwd: example,
    env: {
      ...process.env,
      BILLOS_API_KEY: 'bk_test_stub',
      BILLOS_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      BILLOS_WEBHOOK_SECRET: 'whsec_stub',
      BILLOS_BUSINESS_ID: '',
      // PHP's own server takes one request at a time unless told otherwise, and a delivery
      // arrives while the request that caused it may still be open.
      PHP_CLI_SERVER_WORKERS: '4',
    },
  })
  try {
    await listening(stubPort, 'the stand-in API')
    await listening(appPort, 'php -S')
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['smoke.mjs', `http://127.0.0.1:${appPort}`, `http://127.0.0.1:${stubPort}`], { cwd: stub })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('close', (code) => resolve({ code, out }))
    })
    assert.equal(run.code, 0, `${run.out}\n--- servers ---\n${logs.join('')}`)
    assert.match(run.out, /all steps passed/)
    // Nothing PHP had to warn about on the way: a notice is a bug in an example people copy.
    assert.doesNotMatch(logs.join(''), /PHP (Warning|Notice|Deprecated|Fatal)|Uncaught/, logs.join(''))
  } finally {
    for (const child of [app, api]) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
})
