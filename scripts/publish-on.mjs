// Evaluates the Action `publish-on` condition. The condition lives in the Action
// wrapper only: a run that does not match becomes a dry-run, and the CLI never
// sees the condition.
//
// `publish-on` is a newline-separated list of `event` or `event:ref` entries.
// `event` is compared with GITHUB_EVENT_NAME; `ref` is compared with the full
// GITHUB_REF (for example refs/heads/main) and may use `*` to match any run of
// characters. An empty list means no condition: the run publishes unless
// `dry-run` is true.
const entryPattern = /^([A-Za-z][A-Za-z0-9_]*)(?::(refs\/[^\s:]+))?$/

export function parsePublishOn(value) {
  const entries = []
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const text = line.trim()
    if (!text) continue
    const match = entryPattern.exec(text)
    if (!match) {
      throw new Error(`publish-on entry ${JSON.stringify(text)} must be "event" or "event:refs/..." (for example push:refs/heads/main)`)
    }
    entries.push({ event: match[1], ref: match[2] ?? '' })
  }
  return entries
}

function refMatches(pattern, ref) {
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${source}$`).test(ref)
}

// Returns whether this run should perform real writes, and why.
export function evaluatePublishOn(options = {}) {
  const env = options.env ?? process.env
  const explicitDryRun = Boolean(options.dryRun)
  const entries = parsePublishOn(options.publishOn ?? env.ARTIFACT_PAGES_INPUT_PUBLISH_ON)
  const event = options.eventName ?? env.GITHUB_EVENT_NAME ?? ''
  const ref = options.ref ?? env.GITHUB_REF ?? ''

  if (explicitDryRun) return { dryRun: true, reason: 'dry-run input is true' }
  if (entries.length === 0) return { dryRun: false, reason: '' }
  const matched = entries.some((entry) => entry.event === event && (!entry.ref || refMatches(entry.ref, ref)))
  if (matched) return { dryRun: false, reason: '' }
  return { dryRun: true, reason: `publish-on does not match event ${event || '(none)'} at ${ref || '(no ref)'}` }
}
