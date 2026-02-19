import { defineConfig } from "vitepress"

export default defineConfig({
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
      { text: "About", link: "/introduction" },
      { text: "Docs", link: "/getting-started" },
      { text: "ElectricSQL", link: "https://electric-sql.com" },
      {
        text: "GitHub",
        link: "https://github.com/durable-streams/durable-streams",
      },
    ],
    sidebar: [
      {
        text: "About",
        items: [
          { text: "Introduction", link: "/introduction" },
          { text: "Getting Started", link: "/getting-started" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Core Concepts", link: "/concepts" },
          { text: "State Protocol", link: "/state" },
          { text: "Use Cases", link: "/use-cases" },
          { text: "Deployment", link: "/deployment" },
        ],
      },
      {
        text: "Implementations",
        items: [
          { text: "Client Libraries", link: "/clients" },
          { text: "Servers", link: "/servers" },
          { text: "CLI Reference", link: "/cli" },
        ],
      },
      {
        text: "Development",
        items: [
          { text: "Building a Client", link: "/building-a-client" },
          { text: "Building a Server", link: "/building-a-server" },
          { text: "Benchmarking", link: "/benchmarking" },
        ],
      },
      {
        text: "Reference",
        items: [
          {
            text: "Protocol Specification",
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
