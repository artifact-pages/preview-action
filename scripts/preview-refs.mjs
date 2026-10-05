import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const shaPattern = /^[0-9a-f]{40}$/i

// Resolves the Git refs a preview Action run uses. An explicit input always wins.
// On a pull_request event the event-recorded head SHA and base ref are used only
// as Git-ref defaults; they never create PR provenance (the pull-request input
// stays explicit-only). Every other event keeps the CLI defaults.
export function resolvePreviewRefs(options = {}) {
  const env = options.env ?? process.env
  const explicitHead = String(options.head ?? env.ARTIFACT_PAGES_INPUT_HEAD ?? '').trim()
  const explicitDefaultRef = String(options.defaultRef ?? env.ARTIFACT_PAGES_INPUT_DEFAULT_REF ?? '').trim()
  const eventName = options.eventName ?? env.GITHUB_EVENT_NAME ?? ''

  let head = explicitHead
  let defaultRef = explicitDefaultRef
  let headSource = explicitHead ? 'input' : 'default'
  let defaultRefSource = explicitDefaultRef ? 'input' : 'default'

  if (eventName === 'pull_request' && (!head || !defaultRef)) {
    const pullRequest = (options.event ?? readEvent(env.GITHUB_EVENT_PATH))?.pull_request
    if (!head) {
      const sha = String(pullRequest?.head?.sha ?? '')
      if (!shaPattern.test(sha)) throw new Error('pull_request event is missing a valid head commit SHA; pass the head input explicitly')
      head = sha
      headSource = 'event'
    }
    if (!defaultRef) {
      const baseRef = String(pullRequest?.base?.ref ?? '').trim()
      if (!baseRef) throw new Error('pull_request event is missing the base ref; pass the default-ref input explicitly')
      defaultRef = `origin/${baseRef}`
      defaultRefSource = 'event'
    }
  }

  if (!head) head = 'HEAD'
  if (!defaultRef) defaultRef = 'origin/HEAD'
  return { head, defaultRef, headSource, defaultRefSource, eventName }
}

function readEvent(eventPath) {
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required to read the pull_request event')
  return JSON.parse(readFileSync(eventPath, 'utf8'))
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout.trim() }
}

function resolveCommit(cwd, ref) {
  const result = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  return result.status === 0 && shaPattern.test(result.stdout) ? result.stdout : ''
}

// Fails early, with an actionable message, only for refs the CLI cannot make
// resolvable itself. It never fetches anything and no longer needs full history:
// the CLI fetches a missing `origin/<branch>` default ref or a missing full-SHA
// head at depth 1 and deepens both to the exact merge base (TD13). A ref that is
// absent locally and that the CLI could not fetch (a head that is not a full SHA,
// a default ref that is not `origin/<branch>`) is genuinely unresolvable. Whether
// a fetchable ref exists on the remote is left to the CLI, so the merge base is
// not required here either.
export function assertPreviewRefsReachable(cwd, refs) {
  const fetchHint = 'The checkout may be shallow (`fetch-depth: 1`); the CLI fetches a missing full-SHA head or `origin/<branch>` default ref itself, but cannot fetch any other ref.'
  const head = resolveCommit(cwd, refs.head)
  if (!head && !shaPattern.test(refs.head)) {
    throw new Error(`preview head ${JSON.stringify(refs.head)} does not resolve to a commit in the checkout and is not a full commit SHA, so it cannot be fetched. Pass the head input as a full commit SHA, or check out the repository with \`fetch-depth: 0\`. ${fetchHint}`)
  }
  const base = resolveCommit(cwd, refs.defaultRef)
  if (!base && !fetchableDefaultRef(refs.defaultRef)) {
    throw new Error(`default ref ${JSON.stringify(refs.defaultRef)} does not resolve to a commit in the checkout and is not an origin/<branch> ref, so it cannot be fetched. Pass default-ref as origin/<branch>, or check out the repository with \`fetch-depth: 0\`. ${fetchHint}`)
  }
  return { headSHA: head, defaultRefSHA: base, mergeBaseSHA: head && base ? git(cwd, ['merge-base', head, base]).stdout : '' }
}

function fetchableDefaultRef(ref) {
  const name = String(ref).replace(/^refs\/remotes\//, '')
  return name.startsWith('origin/') && name !== 'origin/HEAD' && !/[\s:^~?*[\\]/.test(name) && !name.includes('..')
}

// Resolves the Action's `pull-request` input. An explicit value always wins and
// `none` forces a manual preview. When the input is empty, only a `pull_request`
// event supplies the PR number from its payload (never pull_request_target, never
// a lookup by branch or commit). The CLI itself stays explicit-only; the returned
// reference is verified by the same trust preflight as an explicit one.
export function resolvePullRequestReference(options = {}) {
  const env = options.env ?? process.env
  const explicit = String(options.pullRequest ?? env.ARTIFACT_PAGES_INPUT_PULL_REQUEST ?? '').trim()
  const eventName = options.eventName ?? env.GITHUB_EVENT_NAME ?? ''
  if (explicit.toLowerCase() === 'none') return { reference: '', source: 'none' }
  if (explicit) return { reference: explicit, source: 'input' }
  if (eventName !== 'pull_request') return { reference: '', source: 'default' }
  const number = (options.event ?? readEvent(env.GITHUB_EVENT_PATH))?.pull_request?.number
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('pull_request event is missing a valid pull request number; pass the pull-request input explicitly or use "none" for a manual preview')
  }
  return { reference: String(number), source: 'event' }
}
