function equal(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

export function isAuthorized(request: Request): boolean {
  const expected = process.env.CHAT_AUTH_TOKEN
  if (!expected) return false
  const bearer = request.headers
    .get(`authorization`)
    ?.replace(/^Bearer\s+/i, ``)
  const cookie = request.headers
    .get(`cookie`)
    ?.match(/(?:^|;\s*)chat_auth=([^;]+)/)?.[1]
  return Boolean(
    (bearer && equal(bearer, expected)) ||
    (cookie && equal(decodeURIComponent(cookie), expected))
  )
}

export function requireAuth(request: Request): Response | null {
  return isAuthorized(request)
    ? null
    : Response.json(
        { error: `Unauthorized` },
        { status: 401, headers: { "Cache-Control": `no-store` } }
      )
}
