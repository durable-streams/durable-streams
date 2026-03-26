import { defineConfig } from "vitepress"
import llmstxt from "vitepress-plugin-llms"
import { buildMetaImageUrl } from "./theme/meta-image"

export default defineConfig({
  head: [
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        href: "/favicon.png",
      },
    ],
    [
      "meta",
      {
        name: "twitter:card",
        content: "summary_large_image",
      },
    ],
    [
      "script",
      {
        defer: "defer",
        "data-domain": "electric-sql.com",
        src: "https://plausible.io/js/script.js",
      },
    ],
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
            collapsed: false,
          },
          { text: "JSON mode", link: "/json-mode" },
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
          { text: "Yjs", link: "/yjs" },
          {
            text: "AnyCable",
            link: "https://docs.anycable.io/anycable-go/durable_streams",
          },
        ],
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
      { icon: "discord", link: "https://discord.gg/VMRbuXQkkz" },
      { icon: "x", link: "https://x.com/DurableStreams" },
      {
        icon: "github",
        link: "https://github.com/durable-streams/durable-streams",
      },
    ],
    search: {
      provider: "local",
    },
    editLink: {
      pattern:
        "https://github.com/durable-streams/durable-streams/edit/main/docs/:path",
    },
    footer: {
      copyright:
        'Released as an <a href="https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md">Open&nbsp;Protocol</a> under the <a href="https://github.com/durable-streams/durable-streams/blob/main/LICENSE">MIT&nbsp;License</a>.',
      message:
        'Made with ♥️ by the team behind <span class="no-wrap"><a href="https://electric-sql.com">ElectricSQL</a>, <a href="https://pglite.dev">PGlite</a> and <a href="https://tanstack.com">TanStack&nbsp;DB</a></span>.',
    },
  },
  transformHead: ({ pageData, siteData }) => {
    const fm = pageData.frontmatter
    const head = []

    const pageTitle = fm.title || siteData.title
    const titleTemplate = fm.titleTemplate || ":title | Durable Streams"
    const title = titleTemplate.replace(":title", pageTitle)
    const description = fm.description || siteData.description

    const PRODUCTION_URL = "https://durablestreams.com"
    const LOCAL_DEV_URL = "http://localhost:5173"
    const DEFAULT_IMAGE = "/img/meta.png"

    const siteOrigin =
      process.env.CONTEXT === "production"
        ? process.env.URL || PRODUCTION_URL
        : process.env.DEPLOY_PRIME_URL ||
          (process.env.NODE_ENV === "development"
            ? LOCAL_DEV_URL
            : PRODUCTION_URL)

    const image = buildMetaImageUrl(fm.image || DEFAULT_IMAGE, siteOrigin)

    head.push([
      "meta",
      { name: "twitter:card", content: "summary_large_image" },
    ])
    head.push(["meta", { name: "twitter:site", content: "@DurableStreams" }])
    head.push(["meta", { name: "twitter:title", content: title }])
    head.push(["meta", { name: "twitter:description", content: description }])
    head.push(["meta", { name: "twitter:image", content: image }])
    head.push(["meta", { property: "og:title", content: title }])
    head.push(["meta", { property: "og:description", content: description }])
    head.push(["meta", { property: "og:image", content: image }])

    return head
  },
  transformPageData(pageData) {
    pageData.frontmatter.editLink = pageData.relativePath.startsWith("docs")
  },
})
