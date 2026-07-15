import { authorizeChatRequest } from "./auth"

export function createChatWorker(
  downstream: { fetch: (request: Request) => Response | Promise<Response> },
  getToken: () => string | undefined
): { fetch: (request: Request) => Promise<Response> } {
  return {
    async fetch(request) {
      const denied = authorizeChatRequest(request, getToken())
      if (denied) return denied
      return downstream.fetch(request)
    },
  }
}
