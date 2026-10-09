// Deliberately bounded exact-release range shared by generated Action metadata.
export function parseVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value ?? '')) throw new Error(`invalid CLI release version: ${value}`)
  return value.split('.').map(Number)
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i])
  return 0
}
export function requireCliRange(version, range) {
  const bounds = /^>=(\S+) <(\S+)$/.exec(range ?? '')
  if (!bounds) throw new Error(`invalid supported CLI range: ${range}`)
  const lower = parseVersion(bounds[1]), upper = parseVersion(bounds[2]), selected = parseVersion(version)
  if (compare(lower, upper) >= 0) throw new Error(`invalid supported CLI range: ${range}`)
  if (compare(selected, lower) < 0 || compare(selected, upper) >= 0) throw new Error(`CLI ${version} is outside this Action's supported range ${range}`)
  return version
}
