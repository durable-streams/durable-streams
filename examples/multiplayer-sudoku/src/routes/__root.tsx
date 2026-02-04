import * as React from "react"
import {
  Outlet,
  HeadContent,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"

import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: `utf-8`,
      },
      {
        name: `viewport`,
        content: `width=device-width, initial-scale=1, maximum-scale=1`,
      },
      {
        title: `Massive Multiplayer Sudoku - 9999 Boxes`,
      },
      {
        name: `description`,
        content: `Play the world's largest multiplayer sudoku puzzle with 9999 boxes! Collaborate with players worldwide in real-time.`,
      },
    ],
    links: [
      {
        rel: `stylesheet`,
        href: appCss,
      },
      {
        rel: `icon`,
        href: `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>9</text></svg>`,
      },
    ],
  }),
  shellComponent: RootDocument,
  component: () => <Outlet />,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-slate-900 text-white min-h-screen">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
