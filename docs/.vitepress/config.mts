import { defineConfig } from "vitepress"
import llmstxt from "vitepress-plugin-llms"

export default defineConfig({
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
      { text: "Docs", link: "/quick-start" },
      {
        text: "GitHub",
        link: "https://github.com/durable-streams/durable-streams",
      },
    ],
    sidebar: [
      {
        text: "Docs",
        items: [
          { text: "Quick Start", link: "/quick-start" },
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
          },
          { text: "JSON Streams", link: "/json-streams" },
          { text: "TanStack AI", link: "/tanstack-ai" },
          { text: "Vercel AI SDK", link: "/vercel-ai-sdk" },
          { text: "State Streams", link: "/state" },
          { text: "Durable Proxy", link: "/proxy" },
          { text: "Stream FS", link: "/streamfs" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Hosting", link: "/hosting" },
          { text: "Servers", link: "/servers" },
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
      message:
        'Released under the <a href="https://github.com/durable-streams/durable-streams/blob/main/LICENSE">MIT License</a>',
      copyright: '© <a href="https://electric-sql.com/">ElectricSQL</a>',
    },
  },
})
