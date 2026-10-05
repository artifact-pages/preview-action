import { appendFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Decides whether the Action runs actions/checkout itself (input `checkout`).
//   auto  - check out only when GITHUB_WORKSPACE is not itself a Git work tree root
//   true  - always check out
//   false - never check out
// It also validates `fetch-depth`. It writes the step output `checkout=true|false`.
export function isGitCheckoutRoot(workspace) {
  if (!workspace) return false
  const result = spawnSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) return false
  try {
    return realpathSync(result.stdout.trim()) === realpathSync(workspace)
  } catch {
    return false
  }
}

export function decideCheckout(options = {}) {
  const env = options.env ?? process.env
  const mode = String(env.ARTIFACT_PAGES_INPUT_CHECKOUT ?? '').trim().toLowerCase() || 'auto'
  if (!['auto', 'true', 'false'].includes(mode)) {
    throw new Error('input "checkout" must be auto, true or false')
  }
  const depth = String(env.ARTIFACT_PAGES_INPUT_FETCH_DEPTH ?? '').trim() || '1'
  if (!/^[0-9]+$/.test(depth)) throw new Error('input "fetch-depth" must be a non-negative integer')
  if (mode === 'true') return { checkout: true, reason: 'checkout is true' }
  if (mode === 'false') return { checkout: false, reason: 'checkout is false' }
  const workspace = env.GITHUB_WORKSPACE ?? ''
  const present = (options.isCheckout ?? isGitCheckoutRoot)(workspace)
  return present
    ? { checkout: false, reason: 'the workspace is already a Git checkout' }
    : { checkout: true, reason: 'the workspace is not a Git checkout' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const decision = decideCheckout()
    process.stdout.write(`Artifact Pages checkout: ${decision.checkout ? 'running actions/checkout' : 'skipping actions/checkout'} (${decision.reason}).\n`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `checkout=${decision.checkout}\n`)
  } catch (error) {
    process.stderr.write(`::error title=Artifact Pages checkout::${error.message}\n`)
    process.exitCode = 2
  }
}
