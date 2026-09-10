export function authorizeChatRequest(
  request: Request,
  configuredToken: string | undefined
): Response | undefined {
  if (!configuredToken) {
    return Response.json(
      { error: `CHAT_AUTH_TOKEN is not configured` },
      { status: 503 }
    )
  }
  if (request.headers.get(`authorization`) !== `Bearer ${configuredToken}`) {
    return Response.json({ error: `Unauthorized` }, { status: 401 })
  }
  return undefined
}
