/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"
import type { ReactNode } from "react"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: `utf-8` },
      { name: `viewport`, content: `width=device-width, initial-scale=1` },
      { title: `Durable Chat — TanStack Start + TanStack AI` },
    ],
    links: [
      {
        rel: `stylesheet`,
        href: `/src/styles.css`,
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

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-gray-50 text-gray-900 antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
