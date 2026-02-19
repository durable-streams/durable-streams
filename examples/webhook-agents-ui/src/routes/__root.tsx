import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router"
import { Theme } from "@radix-ui/themes"

import radixCss from "@radix-ui/themes/styles.css?url"
import interCss from "@fontsource/inter/latin.css?url"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: `utf-8` },
      { name: `viewport`, content: `width=device-width, initial-scale=1` },
      { title: `Webhook Agents` },
    ],
    links: [
      { rel: `stylesheet`, href: radixCss },
      { rel: `stylesheet`, href: interCss },
      { rel: `stylesheet`, href: appCss },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Theme accentColor="indigo" grayColor="slate" radius="medium">
          <Outlet />
        </Theme>
        <Scripts />
      </body>
    </html>
  )
}
