import { defineConfig } from "vitepress"
import llmstxt from "vitepress-plugin-llms"

export default defineConfig({
  head: [
    ["link", { rel: "icon", type: "image/png", href: "/favicon.png" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
  ],
  vite: {
    plugins: [
      llmstxt({
        generateLLMsFullTxt: false,
      }),
    ],
  },
  lang: "en",
  title: "Durable Streams",
  description:
    "Persistent, resumable event streams over HTTP with exactly-once semantics.",
  appearance: "force-dark",
  cleanUrls: true,
  srcExclude: ["README.md", "research/**"],
  ignoreDeadLinks: [/^\/PROTOCOL(\.md)?$/],
  themeConfig: {
    logo: "/img/Icon.svg",
    nav: [
      { text: "Home", link: "/" },
      { text: "Docs", link: "/quickstart" },
      {
        text: "GitHub",
        link: "https://github.com/durable-streams/durable-streams",
      },
    ],
    sidebar: [
      {
        text: "Docs",
        items: [
          { text: "Quickstart", link: "/quickstart" },
          { text: "Core concepts", link: "/concepts" },
        ],
      },
      {
        text: "Usage",
        items: [
          { text: "CLI", link: "/cli" },
          {
            text: "Clients",
            items: [
              { text: "TypeScript", link: "/typescript-client" },
              { text: "Python", link: "/python-client" },
              { text: "Other clients", link: "/clients" },
            ],
            collapsed: false
          },
          { text: "JSON Streams", link: "/json-streams" },
          { text: "Durable Proxy", link: "/durable-proxy" },
          { text: "Durable State", link: "/durable-state" },
          { text: "StreamDB", link: "/stream-db" },
          { text: "StreamFS", link: "/stream-fs" },
        ],
      },
      {
        text: "Integrations",
        items: [
          { text: "TanStack AI", link: "/tanstack-ai" },
          { text: "Vercel AI SDK", link: "/vercel-ai-sdk" },
          { text: "AnyCable", link: "https://docs.anycable.io/anycable-go/durable_streams"},
        ]
      },
      {
        text: "Reference",
        items: [
          { text: "Deployment", link: "/deployment" },
          { text: "Building a client", link: "/building-a-client" },
          { text: "Building a server", link: "/building-a-server" },
          { text: "Benchmarking", link: "/benchmarking" },
          {
            text: "Protocol",
            link: "https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md",
          },
        ],
      },
    ],
    socialLinks: [
      { icon: "discord", link: "https://discord.electric-sql.com" },
      {
        icon: "github",
        link: "https://github.com/durable-streams/durable-streams",
      },
    ],
    search: {
      provider: "local",
    },
    footer: {
      copyright:
        'Released under the <a href="https://github.com/durable-streams/durable-streams/blob/main/LICENSE">MIT License</a>',
      message:
        'Made with ❤️ by the team that built <a href="https://electric-sql.com/">ElectricSQL</a>',
    },
  },
})
