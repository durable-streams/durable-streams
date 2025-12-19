import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"

export function createRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
  })

  return router
}

// Required by TanStack Start for SSR
export function getRouter() {
  return createRouter()
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
