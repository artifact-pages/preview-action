import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolvePullRequestReference } from './preview-refs.mjs'
import { parsePullRequestReference } from './verify-preview-pr.mjs'

const siteIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const maxListedDocuments = 50
const maxCommentPages = 50
const permissionHint = 'add `permissions: pull-requests: write` to the job so the preview Action can post its PR comment'

export function markerFor(site) {
  if (!siteIdPattern.test(site)) throw new Error(`site ${JSON.stringify(site)} cannot be used in a comment marker`)
  return `<!-- artifact-pages-preview:site=${site} -->`
}

// Escapes untrusted text (document titles, paths) for inline Markdown and table cells.
export function escapeMarkdown(value, limit = 200) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length > limit) text = `${text.slice(0, limit - 1)}…`
  return text
    .replace(/[\\`*_{}[\]()<>#+!|~&]/g, (character) => (character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : `\\${character}`))
}

function codeSpan(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().replaceAll('`', "'").replaceAll('|', '\\|')
  return `\`${text}\``
}

function safeURL(value) {
  try {
    const parsed = new URL(String(value ?? ''))
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
    return parsed.href.replace(/[()<>\s]/g, (character) => encodeURIComponent(character))
  } catch {
    return ''
  }
}

function shortSha(value) {
  const sha = String(value ?? '')
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha.slice(0, 7) : ''
}

export function renderPublishedComment({ site, result }) {
  const head = shortSha(result.headSha)
  const lines = [markerFor(site), `### Artifact Pages preview: ${codeSpan(site)}`, '']
  const listURL = safeURL(result.groupListUrl)
  lines.push(listURL ? `[Open the preview list for this pull request](${listURL})` : 'Preview published.')
  const documents = Array.isArray(result.documents) ? result.documents : []
  const changed = documents.filter((document) => document?.reason !== 'dependency')
  const affected = documents.filter((document) => document?.reason === 'dependency')
  // One shared cap across both groups; changed pages are listed first.
  const listedChanged = changed.slice(0, maxListedDocuments)
  const listedAffected = affected.slice(0, maxListedDocuments - listedChanged.length)
  const row = (document) => {
    const url = safeURL(document.url)
    const title = escapeMarkdown(document.title || document.path)
    return `| ${url ? `[${title}](${url})` : title} | ${codeSpan(document.path)} |`
  }
  if (listedChanged.length > 0) {
    if (affected.length > 0) lines.push('', '**Changed pages**')
    lines.push('', '| Page | Path |', '| --- | --- |', ...listedChanged.map(row))
  }
  if (listedAffected.length > 0) {
    lines.push('', '**Affected by a resource change** (these pages did not change, but a stylesheet, script, image, or other resource they use did)')
    lines.push('', '| Page | Path | Changed resource |', '| --- | --- | --- |')
    for (const document of listedAffected) {
      const resources = Array.isArray(document.changedResources) ? document.changedResources.slice(0, 3).map(codeSpan).join(', ') : ''
      lines.push(`${row(document)} ${resources} |`)
    }
  }
  const omittedChanged = changed.length - listedChanged.length
  const omittedAffected = affected.length - listedAffected.length
  if (omittedChanged + omittedAffected > 0) {
    const noun = omittedAffected === 0 ? 'changed pages' : omittedChanged === 0 ? 'affected pages' : 'pages'
    lines.push('', `…and ${omittedChanged + omittedAffected} more ${noun} (see the preview list).`)
  }
  lines.push('', `_Latest preview${head ? ` for commit ${codeSpan(head)}` : ''}. This comment is updated in place on each push._`)
  return lines.join('\n')
}

export function renderNoPreviewComment({ site, result }) {
  const head = shortSha(result.headSha)
  return [
    markerFor(site),
    `### Artifact Pages preview: ${codeSpan(site)}`,
    '',
    `No changed pages to preview for this site${head ? ` at commit ${codeSpan(head)}` : ''}.`,
  ].join('\n')
}

export function renderFailedComment({ site, runURL }) {
  const link = runURL ? ` See the [workflow run](${runURL}) for details.` : ''
  return [
    markerFor(site),
    `### Artifact Pages preview: ${codeSpan(site)}`,
    '',
    `The latest preview failed.${link} The pages listed above, if any, may be out of date.`,
  ].join('\n')
}

function apiHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'artifact-pages-preview-comment',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

class CommentApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

async function call(fetchImpl, url, init) {
  let response
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15000) })
  } catch (error) {
    throw new CommentApiError(`GitHub request failed: ${error.message}`, 0)
  }
  if (!response.ok) throw new CommentApiError(`GitHub returned HTTP ${response.status}`, response.status)
  return response.json()
}

// A personal token authenticates as a user, whose login identifies our comments. The workflow
// token and app tokens cannot read /user (401/403); their comments are authored by a Bot.
async function tokenLogin({ fetchImpl, base, token }) {
  try {
    const user = await call(fetchImpl, `${base}/user`, { method: 'GET', headers: apiHeaders(token) })
    return typeof user?.login === 'string' && user.login ? user.login : ''
  } catch {
    return ''
  }
}

async function findMarkerComment({ fetchImpl, base, repository, number, token, marker }) {
  const login = await tokenLogin({ fetchImpl, base, token })
  const ours = (comment) => (login ? comment.user?.login === login : comment.user?.type === 'Bot')
  for (let page = 1; page <= maxCommentPages; page += 1) {
    const url = `${base}/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`
    const comments = await call(fetchImpl, url, { method: 'GET', headers: apiHeaders(token) })
    if (!Array.isArray(comments)) throw new CommentApiError('GitHub returned an unexpected comment list', 0)
    const match = comments.find((comment) => typeof comment?.body === 'string' && comment.body.startsWith(marker) && ours(comment))
    if (match) return match
    if (comments.length < 100) return undefined
  }
  return undefined
}

function warning(message) {
  process.stdout.write(`::warning title=Artifact Pages preview comment::${message.replace(/[\r\n]+/g, ' ')}\n`)
}

function parseResult(raw) {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// Posts or updates the one marker comment for this site on the explicitly selected PR.
// Never throws for comment problems: a comment failure must not fail the publish.
export async function runPreviewComment(options = {}) {
  const env = options.env ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch
  const none = (reason) => ({ commentUrl: '', action: 'none', reason })

  const enabled = String(env.ARTIFACT_PAGES_INPUT_COMMENT ?? '').trim().toLowerCase()
  if (enabled === '' || enabled === 'false') return none('disabled')
  if (enabled !== 'true') {
    warning('input "comment" must be true or false; skipping the PR comment.')
    return none('invalid-input')
  }
  let pullRequestInput
  try {
    pullRequestInput = resolvePullRequestReference({ env, event: options.event }).reference
  } catch (error) {
    warning(`skipping the PR comment: ${error.message}`)
    return none('invalid-input')
  }
  if (!pullRequestInput) {
    warning('comment is true but this run has no pull request (the event is not pull_request and no pull-request input was given, or pull-request is none); skipping the PR comment.')
    return none('no-pull-request')
  }

  const site = String(env.ARTIFACT_PAGES_INPUT_SITE ?? '').trim()
  const repository = String(env.GITHUB_REPOSITORY ?? '')
  let marker
  let reference
  try {
    marker = markerFor(site)
    reference = parsePullRequestReference(repository, pullRequestInput)
  } catch (error) {
    warning(`skipping the PR comment: ${error.message}`)
    return none('invalid-input')
  }

  const result = parseResult(env.ARTIFACT_PAGES_COMMENT_RESULT ?? '')
  const outcome = String(result.outcome ?? '')
  const exitCode = String(env.ARTIFACT_PAGES_COMMENT_EXIT_CODE ?? '').trim()
  const failed = outcome === 'failed' || outcome === '' || (exitCode !== '' && exitCode !== '0')
  if (!failed && outcome === 'planned') return none('dry-run')

  const serverURL = String(env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/$/, '')
  const runURL = env.GITHUB_RUN_ID ? safeURL(`${serverURL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`) : ''

  let kind
  let body
  if (failed) {
    kind = 'update-only'
    body = renderFailedComment({ site, runURL })
  } else if (outcome === 'no-preview') {
    kind = 'update-only'
    body = renderNoPreviewComment({ site, result })
  } else if (outcome === 'published' || outcome === 'no-op') {
    kind = 'upsert'
    body = renderPublishedComment({ site, result })
  } else {
    return none('unsupported-outcome')
  }

  let base
  try {
    base = new URL(env.GITHUB_API_URL || 'https://api.github.com')
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('untrusted API origin')
    base = `${base.origin}${base.pathname.replace(/\/$/, '')}`
  } catch {
    warning('GITHUB_API_URL must be a trusted HTTPS API origin; skipping the PR comment.')
    return none('invalid-api-url')
  }

  const token = env.GITHUB_TOKEN ?? ''
  try {
    const existing = await findMarkerComment({ fetchImpl, base, repository, number: reference.number, token, marker })
    if (!existing && kind === 'update-only') return none('no-existing-comment')
    const saved = existing
      ? await call(fetchImpl, `${base}/repos/${repository}/issues/comments/${existing.id}`, {
        method: 'PATCH', headers: apiHeaders(token), body: JSON.stringify({ body }),
      })
      : await call(fetchImpl, `${base}/repos/${repository}/issues/${reference.number}/comments`, {
        method: 'POST', headers: apiHeaders(token), body: JSON.stringify({ body }),
      })
    return { commentUrl: String(saved?.html_url ?? ''), action: existing ? 'updated' : 'created', reason: '' }
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      warning(`GitHub denied access to pull request #${reference.number} comments (HTTP ${error.status}); ${permissionHint}. The preview itself is unaffected.`)
    } else {
      warning(`could not write the PR comment: ${error.message}. The preview itself is unaffected.`)
    }
    return none('api-error')
  }
}

async function main() {
  let outcome
  try {
    outcome = await runPreviewComment()
  } catch (error) {
    warning(`could not write the PR comment: ${error.message}`)
    outcome = { commentUrl: '', action: 'none' }
  }
  process.stdout.write(outcome.action === 'none' ? `No PR comment written${outcome.reason ? ` (${outcome.reason})` : ''}.\n` : `PR comment ${outcome.action}: ${outcome.commentUrl}\n`)
  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) {
    const delimiter = `ARTIFACT_PAGES_${randomUUID().replaceAll('-', '')}`
    await appendFile(outputPath, `comment-url<<${delimiter}\n${outcome.commentUrl}\n${delimiter}\n`, 'utf8')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
