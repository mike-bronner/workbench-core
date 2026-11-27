export const dryRunArgvOf = (dir: string, remote: string, branch: string): string[] => {
  const ref = `refs/heads/${branch}`
  return ['git', '-C', dir, 'push', '--dry-run', '--porcelain', '--no-verify', '--follow-tags', '--recurse-submodules=no', '--', remote, `${ref}:${ref}`]
}

export function followedTagsOf(porcelain: string, branch: string): string[] | undefined {
  const lines = porcelain
    .split('\n')
    .map(line => line.split('\t'))
    .filter(([flag = '', spec]) => flag.length === 1 && spec !== undefined)
  const own = `refs/heads/${branch}:refs/heads/${branch}`
  if (!lines.some(([, spec]) => spec === own)) return undefined
  const tags = lines
    .filter(([flag, spec = '']) => flag !== '=' && spec.includes(':refs/tags/'))
    .map(([, spec = '']) => spec.slice(spec.indexOf(':refs/tags/') + ':refs/tags/'.length))
  return [...new Set(tags)]
}
