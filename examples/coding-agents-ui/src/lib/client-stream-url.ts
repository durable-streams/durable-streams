export function buildClientStreamUrl(id: string): string {
  return `/api/stream/${encodeURIComponent(id)}`
}
