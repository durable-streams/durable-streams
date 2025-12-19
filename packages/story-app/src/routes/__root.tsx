import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"
import type { ReactNode } from "react"
import "../styles.css"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: `utf-8` },
      { name: `viewport`, content: `width=device-width, initial-scale=1` },
      { title: `Tell Me a Story!` },
      {
        name: `description`,
        content: `A magical story generator for children`,
      },
    ],
    links: [
      {
        rel: `icon`,
        href: `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📖</text></svg>`,
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen font-story antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
