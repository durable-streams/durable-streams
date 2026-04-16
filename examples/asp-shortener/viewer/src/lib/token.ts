// Read auth token from URL fragment (#t=...). Strip from URL once read so
// it's less likely to leak into history / bookmarks.

export function extractTokenFromFragment(): string | null {
  if (typeof window === `undefined`) return null

  const hash = window.location.hash
  if (!hash || hash.length < 2) return null

  const params = new URLSearchParams(hash.slice(1))
  const token = params.get(`t`)
  if (!token) return null

  // Remove the fragment from the visible URL
  const newUrl = window.location.pathname + window.location.search
  window.history.replaceState(null, ``, newUrl)

  return token
}
