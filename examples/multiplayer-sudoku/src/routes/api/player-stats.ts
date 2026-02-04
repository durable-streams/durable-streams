import { createFileRoute } from "@tanstack/react-router"
import { prepareElectricUrl, proxyElectricRequest } from "@/lib/electric-proxy"

const serve = async ({ request }: { request: Request }) => {
  const originUrl = prepareElectricUrl(request.url)
  originUrl.searchParams.set(`table`, `player_stats`)

  return proxyElectricRequest(originUrl)
}

export const Route = createFileRoute(`/api/player-stats`)({
  server: {
    handlers: {
      GET: serve,
    },
  },
})
