import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { assertPreviewRefsReachable, resolvePreviewRefs, resolvePullRequestReference } from './preview-refs.mjs'
import { writeSummary } from './summary.mjs'

const shaPattern = /^[0-9a-f]{40}$/i

function repositoryName(value, label) {
  const repository = String(value ?? '')
  const parts = repository.split('/')
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error(`${label} must be an owner/repository pair`)
  }
  return `${parts[0]}/${parts[1]}`
}

export function parsePullRequestReference(repository, reference) {
  const input = String(reference ?? '').trim()
  if (/^[1-9][0-9]*$/.test(input)) {
    const number = Number(input)
    if (!Number.isSafeInteger(number)) throw new Error('pull-request number is out of range')
    return { number, url: `https://github.com/${repository}/pull/${number}` }
  }

  let parsed
  try {
    parsed = new URL(input)
  } catch {
    throw new Error('pull-request must be a positive number or canonical GitHub pull URL')
  }
  const match = parsed.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/)
  if (parsed.protocol !== 'https:' || parsed.host !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !match || parsed.pathname !== `/${match?.[1]}/${match?.[2]}/pull/${match?.[3]}`) {
    throw new Error('pull-request must be a canonical https://github.com/OWNER/REPO/pull/NUMBER URL')
  }
  if (`${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`pull-request does not belong to workflow repository ${repository}`)
  }
  const number = Number(match[3])
  if (!Number.isSafeInteger(number)) throw new Error('pull-request number is out of range')
  return { number, url: `https://github.com/${repository}/pull/${number}` }
}

function normalizeFullName(value, label) {
  const fullName = repositoryName(value, label)
  return fullName.toLowerCase()
}

function validatePullRequestMetadata(metadata, repository, number) {
  if (!metadata || metadata.number !== number) {
    throw new Error(`GitHub did not return pull request #${number}`)
  }
  const expectedRepository = repository.toLowerCase()
  if (normalizeFullName(metadata.base?.repo?.full_name, 'pull-request base repository') !== expectedRepository) {
    throw new Error(`pull request #${number} does not target workflow repository ${repository}`)
  }
  if (normalizeFullName(metadata.head?.repo?.full_name, 'pull-request head repository') !== expectedRepository) {
    throw new Error(`pull request #${number} must originate from workflow repository ${repository}`)
  }
  const headSha = String(metadata.head?.sha ?? '')
  if (!shaPattern.test(headSha)) throw new Error(`pull request #${number} returned an invalid head SHA`)
  const canonicalURL = `https://github.com/${repository}/pull/${number}`
  if (metadata.html_url && String(metadata.html_url).toLowerCase() !== canonicalURL.toLowerCase()) {
    throw new Error(`pull request #${number} returned a non-canonical GitHub URL`)
  }
  return { headSha, url: canonicalURL }
}

function resolveGitHead(repositoryDirectory, ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`preview head ${JSON.stringify(ref)} does not resolve to a Git commit`)
  const sha = result.stdout.trim()
  if (!shaPattern.test(sha)) throw new Error('selected preview head did not resolve to a full Git SHA')
  return sha
}

async function fetchPullRequest({ apiBaseURL, token, repository, number, fetchImpl }) {
  let base
  try {
    base = new URL(apiBaseURL)
  } catch {
    throw new Error('GITHUB_API_URL is invalid')
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('GITHUB_API_URL must be a trusted HTTPS API origin')
  }
  const encodedRepository = repository.split('/').map(encodeURIComponent).join('/')
  const endpoint = new URL(`${base.pathname.replace(/\/$/, '')}/repos/${encodedRepository}/pulls/${number}`, base)
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await fetchImpl(endpoint, { method: 'GET', headers, signal: AbortSignal.timeout(15000) })
  } catch (error) {
    throw new Error(`could not verify pull request #${number} with GitHub: ${error.message}`)
  }
  if (response.status !== 200) {
    throw new Error(`GitHub pull-request preflight returned HTTP ${response.status}`)
  }
  const body = await response.text()
  if (body.length > 1024 * 1024) throw new Error('GitHub pull-request preflight response exceeded 1 MiB')
  let metadata
  try {
    metadata = JSON.parse(body)
  } catch {
    throw new Error('GitHub returned invalid pull-request metadata')
  }
  return validatePullRequestMetadata(metadata, repository, number)
}

function readPullRequestEvent(eventName, event) {
  if (eventName === 'pull_request_target') {
    throw new Error('pull_request_target is not supported for preview publication')
  }
  if (eventName !== 'pull_request') return undefined
  const pullRequest = event?.pull_request
  if (!pullRequest) throw new Error('pull_request event is missing pull_request metadata')
  return pullRequest
}

export async function verifyPreviewTrust(options = {}) {
  const env = options.env ?? process.env
  const repository = repositoryName(options.repository ?? env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')
  const eventName = options.eventName ?? env.GITHUB_EVENT_NAME ?? ''
  const event = options.event ?? (env.GITHUB_EVENT_PATH
    ? JSON.parse(await (await import('node:fs/promises')).readFile(env.GITHUB_EVENT_PATH, 'utf8'))
    : {})
  const eventPullRequest = readPullRequestEvent(eventName, event)
  const explicitReference = resolvePullRequestReference({ env, eventName, event, pullRequest: options.pullRequest }).reference

  if (eventPullRequest) {
    const baseRepository = normalizeFullName(eventPullRequest.base?.repo?.full_name, 'event pull-request base repository')
    const headRepository = normalizeFullName(eventPullRequest.head?.repo?.full_name, 'event pull-request head repository')
    const workflowRepository = repository.toLowerCase()
    if (baseRepository !== workflowRepository) {
      throw new Error(`pull-request event base repository does not match ${repository}`)
    }
    if (headRepository !== workflowRepository) {
      throw new Error(`fork-origin pull requests cannot publish previews for ${repository}`)
    }
    if (!shaPattern.test(String(eventPullRequest.head?.sha ?? ''))) {
      throw new Error('pull-request event is missing a valid head commit SHA')
    }
  }

  if (!explicitReference) {
    // No PR number was given or defaulted (non-PR event, or `none`): a manual preview.
    return { explicit: false }
  }

  const reference = parsePullRequestReference(repository, explicitReference)
  if (eventPullRequest && Number(eventPullRequest.number) !== reference.number) {
    throw new Error('explicit pull-request input does not match the current pull_request event')
  }
  const metadata = await fetchPullRequest({
    apiBaseURL: options.apiBaseURL ?? env.GITHUB_API_URL ?? 'https://api.github.com',
    token: options.token ?? env.GITHUB_TOKEN ?? '',
    repository,
    number: reference.number,
    fetchImpl: options.fetchImpl ?? fetch,
  })

  if (eventPullRequest && String(eventPullRequest.head.sha).toLowerCase() !== metadata.headSha.toLowerCase()) {
    throw new Error('pull-request event head SHA no longer matches GitHub pull-request metadata')
  }

  const selectedHead = String(options.head ?? env.ARTIFACT_PAGES_INPUT_HEAD ?? '').trim()
  if (selectedHead) {
    // A full SHA is compared directly: a shallow base-ref checkout does not contain
    // the head commit, and the comparison needs no local objects (TD13, IMP-58).
    const checkout = options.repositoryDirectory ?? env.GITHUB_WORKSPACE ?? process.cwd()
    const selectedHeadSHA = shaPattern.test(selectedHead) ? selectedHead : resolveGitHead(checkout, selectedHead)
    if (selectedHeadSHA.toLowerCase() !== metadata.headSha.toLowerCase()) {
      throw new Error(`selected preview head does not match same-repository pull request #${reference.number}`)
    }
  }

  return { explicit: true, pullRequestURL: metadata.url, headSHA: metadata.headSha }
}

// Trust has already been checked before this helper is called. Fetch only the
// selected base object; config bytes and CLI downloads remain untouched here.
export function ensureTrustedBase(cwd, reference, env = process.env) {
  let result = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`], { cwd, encoding: 'utf8' })
  if (result.status === 0 && shaPattern.test(result.stdout.trim())) return result.stdout.trim()
  const branch = /^origin\/([^\s:^~?*\[\\]+)$/.exec(reference ?? '')
  if (!shaPattern.test(reference ?? '') && (!branch || reference.includes('..'))) throw new Error('trusted config base must be a full commit SHA or origin branch')
  const fetchEnv = { ...env }
  delete fetchEnv.GITHUB_TOKEN
  delete fetchEnv.GH_TOKEN
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8' })
  const header = origin.status === 0 ? spawnSync('git', ['config', '--get-urlmatch', 'http.extraheader', origin.stdout.trim()], { cwd, encoding: 'utf8' }) : undefined
  // Ignore caller Git config injection; the header is scoped to GitHub HTTPS.
  fetchEnv.GIT_CONFIG_COUNT = '0'
  if (env.ARTIFACT_PAGES_FETCH_TOKEN && !header?.stdout.trim()) {
    fetchEnv.GIT_CONFIG_COUNT = '1'
    fetchEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    fetchEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.ARTIFACT_PAGES_FETCH_TOKEN}`).toString('base64')}`
  }
  const fetch = spawnSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', branch ? `${branch[1] === 'HEAD' ? 'HEAD' : `refs/heads/${branch[1]}`}:refs/remotes/origin/${branch[1]}` : reference], { cwd, env: fetchEnv, encoding: 'utf8' })
  if (fetch.status !== 0) throw new Error('could not fetch the trusted config base commit; check default ref and workflow repository permissions')
  result = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${shaPattern.test(reference) ? reference : 'FETCH_HEAD'}^{commit}`], { cwd, encoding: 'utf8' })
  if (result.status !== 0 || !shaPattern.test(result.stdout.trim())) throw new Error('trusted config base did not resolve to a full commit SHA')
  return result.stdout.trim()
}

async function main() {
  try {
    const result = await verifyPreviewTrust()
    if (result.explicit) {
      process.stdout.write(`Verified same-repository preview PR ${result.pullRequestURL} at ${result.headSHA}.\n`)
    } else {
      process.stdout.write('Preview trust preflight passed; no pull-request provenance was requested.\n')
    }
    let refs
    let reachable
    try {
      refs = resolvePreviewRefs()
      reachable = assertPreviewRefsReachable(process.env.GITHUB_WORKSPACE || process.cwd(), refs)
    } catch (error) {
      error.label = 'Preview Git ref check failed'
      throw error
    }
    let trustedConfigRef = reachable.defaultRefSHA
    if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
      const event = JSON.parse(await (await import('node:fs/promises')).readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
      const baseSha = event.pull_request?.base?.sha
      if (!shaPattern.test(baseSha ?? '')) throw new Error('pull_request event is missing a valid trusted base SHA for config resolution')
      trustedConfigRef = baseSha
    }
    trustedConfigRef = ensureTrustedBase(process.env.GITHUB_WORKSPACE || process.cwd(), trustedConfigRef || refs.defaultRef)
    await appendStepOutputs({ trusted: 'true', 'trusted-config-ref': trustedConfigRef })
    const known = (sha) => sha || 'fetched by the CLI'
    process.stdout.write(`Preview head ${refs.head} (${refs.headSource}) -> ${known(reachable.headSHA)}; default ref ${refs.defaultRef} (${refs.defaultRefSource}) -> ${known(reachable.defaultRefSHA)}; the CLI deepens a shallow checkout to the exact merge base.\n`)
  } catch (error) {
    process.stderr.write(`${error.label ?? 'Preview trust preflight failed'}: ${error.message}\n`)
    await writePreflightFailure(error)
    process.exitCode = 1
  }
}

async function writePreflightFailure(error) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) return
  const result = {
    operation: 'preview publish',
    outcome: 'failed',
    site: String(process.env.ARTIFACT_PAGES_INPUT_SITE ?? '').trim(),
    groupListUrl: '',
    documents: [],
    objects: [],
    catalogChanges: [],
    error: error.message,
  }
  const values = {
    operation: result.operation,
    outcome: result.outcome,
    site: result.site,
    'group-list-url': result.groupListUrl,
    documents: JSON.stringify(result.documents),
    result: JSON.stringify(result),
    'exit-code': '1',
    error: result.error,
  }
  await appendStepOutputs(values)
  await writeSummary({ kind: 'preview', operation: 'preview publish', result, exitCode: 1 })
}

async function appendStepOutputs(values) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) return
  const delimiter = `ARTIFACT_PAGES_${randomUUID().replaceAll('-', '')}`
  const content = Object.entries(values)
    .map(([name, value]) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
    .join('')
  await appendFile(outputPath, content, 'utf8')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
