import { createFileRoute } from "@tanstack/react-router"
import { prepareElectricUrl, proxyElectricRequest } from "@/lib/electric-proxy"

const serve = async ({ request }: { request: Request }) => {
  const originUrl = prepareElectricUrl(request.url)
  originUrl.searchParams.set(`table`, `sudoku_cells`)

  return proxyElectricRequest(originUrl)
}

export const Route = createFileRoute(`/api/sudoku-cells`)({
  server: {
    handlers: {
      GET: serve,
    },
  },
})
