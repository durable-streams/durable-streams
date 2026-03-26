// .vitepress/config.mts
import { defineConfig } from "file:///Users/kevin/Documents/Electric/development/durable-streams/node_modules/.pnpm/vitepress@1.6.4_@algolia+client-search@5.49.2_@types+node@22.19.7_lightningcss@1.32.0_postcss_7nk6twnvq2nf4xh2kijahiljea/node_modules/vitepress/dist/node/index.js";
import llmstxt from "file:///Users/kevin/Documents/Electric/development/durable-streams/node_modules/.pnpm/vitepress-plugin-llms@1.12.0/node_modules/vitepress-plugin-llms/dist/index.js";

// .vitepress/theme/meta-image.ts
function isAbsoluteUrl(url) {
  return /^(https?:)?\/\//.test(url);
}
function buildFullImageUrl(imagePath, siteOrigin) {
  if (isAbsoluteUrl(imagePath)) {
    return imagePath;
  }
  const normalizedPath = imagePath.startsWith(`/`) ? imagePath : `/${imagePath}`;
  return `${siteOrigin}${normalizedPath}`;
}
function buildMetaImageUrl(imagePath, siteOrigin) {
  const fullImageUrl = buildFullImageUrl(imagePath, siteOrigin);
  return `${siteOrigin}/.netlify/images?url=${encodeURIComponent(fullImageUrl)}&w=1200&h=630&fit=cover&fm=jpg&q=80`;
}

// .vitepress/config.mts
var config_default = defineConfig({
  head: [
    [
      "link",
      {
        rel: "icon",
        type: "image/png",
        href: "/favicon.png"
      }
    ],
    [
      "meta",
      {
        name: "twitter:card",
        content: "summary_large_image"
      }
    ],
    [
      "script",
      {
        defer: "defer",
        "data-domain": "electric-sql.com",
        src: "https://plausible.io/js/script.js"
      }
    ]
  ],
  vite: {
    plugins: [
      llmstxt({
        generateLLMsFullTxt: false
      })
    ]
  },
  lang: "en",
  title: "Durable Streams",
  description: "Persistent, resumable event streams over HTTP with exactly-once semantics.",
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
        link: "https://github.com/durable-streams/durable-streams"
      }
    ],
    sidebar: [
      {
        text: "Docs",
        items: [
          { text: "Quickstart", link: "/quickstart" },
          { text: "Core concepts", link: "/concepts" }
        ]
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
              { text: "Other clients", link: "/clients" }
            ],
            collapsed: false
          },
          { text: "JSON mode", link: "/json-mode" },
          { text: "Durable Proxy", link: "/durable-proxy" },
          { text: "Durable State", link: "/durable-state" },
          { text: "StreamDB", link: "/stream-db" },
          { text: "StreamFS", link: "/stream-fs" }
        ]
      },
      {
        text: "Integrations",
        items: [
          { text: "TanStack AI", link: "/tanstack-ai" },
          { text: "Vercel AI SDK", link: "/vercel-ai-sdk" },
          {
            text: "AnyCable",
            link: "https://docs.anycable.io/anycable-go/durable_streams"
          }
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
            link: "https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md"
          }
        ]
      }
    ],
    socialLinks: [
      { icon: "discord", link: "https://discord.gg/VMRbuXQkkz" },
      { icon: "x", link: "https://x.com/DurableStreams" },
      {
        icon: "github",
        link: "https://github.com/durable-streams/durable-streams"
      }
    ],
    search: {
      provider: "local"
    },
    editLink: {
      pattern: "https://github.com/durable-streams/durable-streams/edit/main/docs/:path"
    },
    footer: {
      copyright: 'Released as an <a href="https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md">Open&nbsp;Protocol</a> under the <a href="https://github.com/durable-streams/durable-streams/blob/main/LICENSE">MIT&nbsp;License</a>.',
      message: 'Made with \u2665\uFE0F by the team behind <span class="no-wrap"><a href="https://electric-sql.com">ElectricSQL</a>, <a href="https://pglite.dev">PGlite</a> and <a href="https://tanstack.com">TanStack&nbsp;DB</a></span>.'
    }
  },
  transformHead: ({ pageData, siteData }) => {
    const fm = pageData.frontmatter;
    const head = [];
    const pageTitle = fm.title || siteData.title;
    const titleTemplate = fm.titleTemplate || ":title | Durable Streams";
    const title = titleTemplate.replace(":title", pageTitle);
    const description = fm.description || siteData.description;
    const PRODUCTION_URL = "https://durablestreams.com";
    const LOCAL_DEV_URL = "http://localhost:5173";
    const DEFAULT_IMAGE = "/img/meta.png";
    const siteOrigin = process.env.CONTEXT === "production" ? process.env.URL || PRODUCTION_URL : process.env.DEPLOY_PRIME_URL || (process.env.NODE_ENV === "development" ? LOCAL_DEV_URL : PRODUCTION_URL);
    const image = buildMetaImageUrl(fm.image || DEFAULT_IMAGE, siteOrigin);
    head.push([
      "meta",
      { name: "twitter:card", content: "summary_large_image" }
    ]);
    head.push(["meta", { name: "twitter:site", content: "@DurableStreams" }]);
    head.push(["meta", { name: "twitter:title", content: title }]);
    head.push(["meta", { name: "twitter:description", content: description }]);
    head.push(["meta", { name: "twitter:image", content: image }]);
    head.push(["meta", { property: "og:title", content: title }]);
    head.push(["meta", { property: "og:description", content: description }]);
    head.push(["meta", { property: "og:image", content: image }]);
    return head;
  },
  transformPageData(pageData) {
    pageData.frontmatter.editLink = pageData.relativePath.startsWith("docs");
  }
});
export {
  config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLnZpdGVwcmVzcy9jb25maWcubXRzIiwgIi52aXRlcHJlc3MvdGhlbWUvbWV0YS1pbWFnZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy9rZXZpbi9Eb2N1bWVudHMvRWxlY3RyaWMvZGV2ZWxvcG1lbnQvZHVyYWJsZS1zdHJlYW1zL2RvY3MvLnZpdGVwcmVzc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL1VzZXJzL2tldmluL0RvY3VtZW50cy9FbGVjdHJpYy9kZXZlbG9wbWVudC9kdXJhYmxlLXN0cmVhbXMvZG9jcy8udml0ZXByZXNzL2NvbmZpZy5tdHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1VzZXJzL2tldmluL0RvY3VtZW50cy9FbGVjdHJpYy9kZXZlbG9wbWVudC9kdXJhYmxlLXN0cmVhbXMvZG9jcy8udml0ZXByZXNzL2NvbmZpZy5tdHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZXByZXNzXCJcbmltcG9ydCBsbG1zdHh0IGZyb20gXCJ2aXRlcHJlc3MtcGx1Z2luLWxsbXNcIlxuaW1wb3J0IHsgYnVpbGRNZXRhSW1hZ2VVcmwgfSBmcm9tIFwiLi90aGVtZS9tZXRhLWltYWdlXCJcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgaGVhZDogW1xuICAgIFtcbiAgICAgIFwibGlua1wiLFxuICAgICAge1xuICAgICAgICByZWw6IFwiaWNvblwiLFxuICAgICAgICB0eXBlOiBcImltYWdlL3BuZ1wiLFxuICAgICAgICBocmVmOiBcIi9mYXZpY29uLnBuZ1wiLFxuICAgICAgfSxcbiAgICBdLFxuICAgIFtcbiAgICAgIFwibWV0YVwiLFxuICAgICAge1xuICAgICAgICBuYW1lOiBcInR3aXR0ZXI6Y2FyZFwiLFxuICAgICAgICBjb250ZW50OiBcInN1bW1hcnlfbGFyZ2VfaW1hZ2VcIixcbiAgICAgIH0sXG4gICAgXSxcbiAgICBbXG4gICAgICBcInNjcmlwdFwiLFxuICAgICAge1xuICAgICAgICBkZWZlcjogXCJkZWZlclwiLFxuICAgICAgICBcImRhdGEtZG9tYWluXCI6IFwiZWxlY3RyaWMtc3FsLmNvbVwiLFxuICAgICAgICBzcmM6IFwiaHR0cHM6Ly9wbGF1c2libGUuaW8vanMvc2NyaXB0LmpzXCIsXG4gICAgICB9LFxuICAgIF0sXG4gIF0sXG4gIHZpdGU6IHtcbiAgICBwbHVnaW5zOiBbXG4gICAgICBsbG1zdHh0KHtcbiAgICAgICAgZ2VuZXJhdGVMTE1zRnVsbFR4dDogZmFsc2UsXG4gICAgICB9KSxcbiAgICBdLFxuICB9LFxuICBsYW5nOiBcImVuXCIsXG4gIHRpdGxlOiBcIkR1cmFibGUgU3RyZWFtc1wiLFxuICBkZXNjcmlwdGlvbjpcbiAgICBcIlBlcnNpc3RlbnQsIHJlc3VtYWJsZSBldmVudCBzdHJlYW1zIG92ZXIgSFRUUCB3aXRoIGV4YWN0bHktb25jZSBzZW1hbnRpY3MuXCIsXG4gIGFwcGVhcmFuY2U6IFwiZm9yY2UtZGFya1wiLFxuICBjbGVhblVybHM6IHRydWUsXG4gIHNyY0V4Y2x1ZGU6IFtcIlJFQURNRS5tZFwiLCBcInJlc2VhcmNoLyoqXCJdLFxuICBpZ25vcmVEZWFkTGlua3M6IFsvXlxcL1BST1RPQ09MKFxcLm1kKT8kL10sXG4gIHRoZW1lQ29uZmlnOiB7XG4gICAgbG9nbzogXCIvaW1nL0ljb24uc3ZnXCIsXG4gICAgbmF2OiBbXG4gICAgICB7IHRleHQ6IFwiSG9tZVwiLCBsaW5rOiBcIi9cIiB9LFxuICAgICAgeyB0ZXh0OiBcIkRvY3NcIiwgbGluazogXCIvcXVpY2tzdGFydFwiIH0sXG4gICAgICB7XG4gICAgICAgIHRleHQ6IFwiR2l0SHViXCIsXG4gICAgICAgIGxpbms6IFwiaHR0cHM6Ly9naXRodWIuY29tL2R1cmFibGUtc3RyZWFtcy9kdXJhYmxlLXN0cmVhbXNcIixcbiAgICAgIH0sXG4gICAgXSxcbiAgICBzaWRlYmFyOiBbXG4gICAgICB7XG4gICAgICAgIHRleHQ6IFwiRG9jc1wiLFxuICAgICAgICBpdGVtczogW1xuICAgICAgICAgIHsgdGV4dDogXCJRdWlja3N0YXJ0XCIsIGxpbms6IFwiL3F1aWNrc3RhcnRcIiB9LFxuICAgICAgICAgIHsgdGV4dDogXCJDb3JlIGNvbmNlcHRzXCIsIGxpbms6IFwiL2NvbmNlcHRzXCIgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHRleHQ6IFwiVXNhZ2VcIixcbiAgICAgICAgaXRlbXM6IFtcbiAgICAgICAgICB7IHRleHQ6IFwiQ0xJXCIsIGxpbms6IFwiL2NsaVwiIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgdGV4dDogXCJDbGllbnRzXCIsXG4gICAgICAgICAgICBpdGVtczogW1xuICAgICAgICAgICAgICB7IHRleHQ6IFwiVHlwZVNjcmlwdFwiLCBsaW5rOiBcIi90eXBlc2NyaXB0LWNsaWVudFwiIH0sXG4gICAgICAgICAgICAgIHsgdGV4dDogXCJQeXRob25cIiwgbGluazogXCIvcHl0aG9uLWNsaWVudFwiIH0sXG4gICAgICAgICAgICAgIHsgdGV4dDogXCJPdGhlciBjbGllbnRzXCIsIGxpbms6IFwiL2NsaWVudHNcIiB9LFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIGNvbGxhcHNlZDogZmFsc2UsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7IHRleHQ6IFwiSlNPTiBtb2RlXCIsIGxpbms6IFwiL2pzb24tbW9kZVwiIH0sXG4gICAgICAgICAgeyB0ZXh0OiBcIkR1cmFibGUgUHJveHlcIiwgbGluazogXCIvZHVyYWJsZS1wcm94eVwiIH0sXG4gICAgICAgICAgeyB0ZXh0OiBcIkR1cmFibGUgU3RhdGVcIiwgbGluazogXCIvZHVyYWJsZS1zdGF0ZVwiIH0sXG4gICAgICAgICAgeyB0ZXh0OiBcIlN0cmVhbURCXCIsIGxpbms6IFwiL3N0cmVhbS1kYlwiIH0sXG4gICAgICAgICAgeyB0ZXh0OiBcIlN0cmVhbUZTXCIsIGxpbms6IFwiL3N0cmVhbS1mc1wiIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICB0ZXh0OiBcIkludGVncmF0aW9uc1wiLFxuICAgICAgICBpdGVtczogW1xuICAgICAgICAgIHsgdGV4dDogXCJUYW5TdGFjayBBSVwiLCBsaW5rOiBcIi90YW5zdGFjay1haVwiIH0sXG4gICAgICAgICAgeyB0ZXh0OiBcIlZlcmNlbCBBSSBTREtcIiwgbGluazogXCIvdmVyY2VsLWFpLXNka1wiIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgdGV4dDogXCJBbnlDYWJsZVwiLFxuICAgICAgICAgICAgbGluazogXCJodHRwczovL2RvY3MuYW55Y2FibGUuaW8vYW55Y2FibGUtZ28vZHVyYWJsZV9zdHJlYW1zXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIHRleHQ6IFwiUmVmZXJlbmNlXCIsXG4gICAgICAgIGl0ZW1zOiBbXG4gICAgICAgICAgeyB0ZXh0OiBcIkRlcGxveW1lbnRcIiwgbGluazogXCIvZGVwbG95bWVudFwiIH0sXG4gICAgICAgICAgeyB0ZXh0OiBcIkJ1aWxkaW5nIGEgY2xpZW50XCIsIGxpbms6IFwiL2J1aWxkaW5nLWEtY2xpZW50XCIgfSxcbiAgICAgICAgICB7IHRleHQ6IFwiQnVpbGRpbmcgYSBzZXJ2ZXJcIiwgbGluazogXCIvYnVpbGRpbmctYS1zZXJ2ZXJcIiB9LFxuICAgICAgICAgIHsgdGV4dDogXCJCZW5jaG1hcmtpbmdcIiwgbGluazogXCIvYmVuY2htYXJraW5nXCIgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB0ZXh0OiBcIlByb3RvY29sXCIsXG4gICAgICAgICAgICBsaW5rOiBcImh0dHBzOi8vZ2l0aHViLmNvbS9kdXJhYmxlLXN0cmVhbXMvZHVyYWJsZS1zdHJlYW1zL2Jsb2IvbWFpbi9QUk9UT0NPTC5tZFwiLFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF0sXG4gICAgc29jaWFsTGlua3M6IFtcbiAgICAgIHsgaWNvbjogXCJkaXNjb3JkXCIsIGxpbms6IFwiaHR0cHM6Ly9kaXNjb3JkLmdnL1ZNUmJ1WFFra3pcIiB9LFxuICAgICAgeyBpY29uOiBcInhcIiwgbGluazogXCJodHRwczovL3guY29tL0R1cmFibGVTdHJlYW1zXCIgfSxcbiAgICAgIHtcbiAgICAgICAgaWNvbjogXCJnaXRodWJcIixcbiAgICAgICAgbGluazogXCJodHRwczovL2dpdGh1Yi5jb20vZHVyYWJsZS1zdHJlYW1zL2R1cmFibGUtc3RyZWFtc1wiLFxuICAgICAgfSxcbiAgICBdLFxuICAgIHNlYXJjaDoge1xuICAgICAgcHJvdmlkZXI6IFwibG9jYWxcIixcbiAgICB9LFxuICAgIGVkaXRMaW5rOiB7XG4gICAgICBwYXR0ZXJuOlxuICAgICAgICBcImh0dHBzOi8vZ2l0aHViLmNvbS9kdXJhYmxlLXN0cmVhbXMvZHVyYWJsZS1zdHJlYW1zL2VkaXQvbWFpbi9kb2NzLzpwYXRoXCIsXG4gICAgfSxcbiAgICBmb290ZXI6IHtcbiAgICAgIGNvcHlyaWdodDpcbiAgICAgICAgJ1JlbGVhc2VkIGFzIGFuIDxhIGhyZWY9XCJodHRwczovL2dpdGh1Yi5jb20vZHVyYWJsZS1zdHJlYW1zL2R1cmFibGUtc3RyZWFtcy9ibG9iL21haW4vUFJPVE9DT0wubWRcIj5PcGVuJm5ic3A7UHJvdG9jb2w8L2E+IHVuZGVyIHRoZSA8YSBocmVmPVwiaHR0cHM6Ly9naXRodWIuY29tL2R1cmFibGUtc3RyZWFtcy9kdXJhYmxlLXN0cmVhbXMvYmxvYi9tYWluL0xJQ0VOU0VcIj5NSVQmbmJzcDtMaWNlbnNlPC9hPi4nLFxuICAgICAgbWVzc2FnZTpcbiAgICAgICAgJ01hZGUgd2l0aCBcdTI2NjVcdUZFMEYgYnkgdGhlIHRlYW0gYmVoaW5kIDxzcGFuIGNsYXNzPVwibm8td3JhcFwiPjxhIGhyZWY9XCJodHRwczovL2VsZWN0cmljLXNxbC5jb21cIj5FbGVjdHJpY1NRTDwvYT4sIDxhIGhyZWY9XCJodHRwczovL3BnbGl0ZS5kZXZcIj5QR2xpdGU8L2E+IGFuZCA8YSBocmVmPVwiaHR0cHM6Ly90YW5zdGFjay5jb21cIj5UYW5TdGFjayZuYnNwO0RCPC9hPjwvc3Bhbj4uJyxcbiAgICB9LFxuICB9LFxuICB0cmFuc2Zvcm1IZWFkOiAoeyBwYWdlRGF0YSwgc2l0ZURhdGEgfSkgPT4ge1xuICAgIGNvbnN0IGZtID0gcGFnZURhdGEuZnJvbnRtYXR0ZXJcbiAgICBjb25zdCBoZWFkID0gW11cblxuICAgIGNvbnN0IHBhZ2VUaXRsZSA9IGZtLnRpdGxlIHx8IHNpdGVEYXRhLnRpdGxlXG4gICAgY29uc3QgdGl0bGVUZW1wbGF0ZSA9IGZtLnRpdGxlVGVtcGxhdGUgfHwgXCI6dGl0bGUgfCBEdXJhYmxlIFN0cmVhbXNcIlxuICAgIGNvbnN0IHRpdGxlID0gdGl0bGVUZW1wbGF0ZS5yZXBsYWNlKFwiOnRpdGxlXCIsIHBhZ2VUaXRsZSlcbiAgICBjb25zdCBkZXNjcmlwdGlvbiA9IGZtLmRlc2NyaXB0aW9uIHx8IHNpdGVEYXRhLmRlc2NyaXB0aW9uXG5cbiAgICBjb25zdCBQUk9EVUNUSU9OX1VSTCA9IFwiaHR0cHM6Ly9kdXJhYmxlc3RyZWFtcy5jb21cIlxuICAgIGNvbnN0IExPQ0FMX0RFVl9VUkwgPSBcImh0dHA6Ly9sb2NhbGhvc3Q6NTE3M1wiXG4gICAgY29uc3QgREVGQVVMVF9JTUFHRSA9IFwiL2ltZy9tZXRhLnBuZ1wiXG5cbiAgICBjb25zdCBzaXRlT3JpZ2luID1cbiAgICAgIHByb2Nlc3MuZW52LkNPTlRFWFQgPT09IFwicHJvZHVjdGlvblwiXG4gICAgICAgID8gcHJvY2Vzcy5lbnYuVVJMIHx8IFBST0RVQ1RJT05fVVJMXG4gICAgICAgIDogcHJvY2Vzcy5lbnYuREVQTE9ZX1BSSU1FX1VSTCB8fFxuICAgICAgICAgIChwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gXCJkZXZlbG9wbWVudFwiXG4gICAgICAgICAgICA/IExPQ0FMX0RFVl9VUkxcbiAgICAgICAgICAgIDogUFJPRFVDVElPTl9VUkwpXG5cbiAgICBjb25zdCBpbWFnZSA9IGJ1aWxkTWV0YUltYWdlVXJsKGZtLmltYWdlIHx8IERFRkFVTFRfSU1BR0UsIHNpdGVPcmlnaW4pXG5cbiAgICBoZWFkLnB1c2goW1xuICAgICAgXCJtZXRhXCIsXG4gICAgICB7IG5hbWU6IFwidHdpdHRlcjpjYXJkXCIsIGNvbnRlbnQ6IFwic3VtbWFyeV9sYXJnZV9pbWFnZVwiIH0sXG4gICAgXSlcbiAgICBoZWFkLnB1c2goW1wibWV0YVwiLCB7IG5hbWU6IFwidHdpdHRlcjpzaXRlXCIsIGNvbnRlbnQ6IFwiQER1cmFibGVTdHJlYW1zXCIgfV0pXG4gICAgaGVhZC5wdXNoKFtcIm1ldGFcIiwgeyBuYW1lOiBcInR3aXR0ZXI6dGl0bGVcIiwgY29udGVudDogdGl0bGUgfV0pXG4gICAgaGVhZC5wdXNoKFtcIm1ldGFcIiwgeyBuYW1lOiBcInR3aXR0ZXI6ZGVzY3JpcHRpb25cIiwgY29udGVudDogZGVzY3JpcHRpb24gfV0pXG4gICAgaGVhZC5wdXNoKFtcIm1ldGFcIiwgeyBuYW1lOiBcInR3aXR0ZXI6aW1hZ2VcIiwgY29udGVudDogaW1hZ2UgfV0pXG4gICAgaGVhZC5wdXNoKFtcIm1ldGFcIiwgeyBwcm9wZXJ0eTogXCJvZzp0aXRsZVwiLCBjb250ZW50OiB0aXRsZSB9XSlcbiAgICBoZWFkLnB1c2goW1wibWV0YVwiLCB7IHByb3BlcnR5OiBcIm9nOmRlc2NyaXB0aW9uXCIsIGNvbnRlbnQ6IGRlc2NyaXB0aW9uIH1dKVxuICAgIGhlYWQucHVzaChbXCJtZXRhXCIsIHsgcHJvcGVydHk6IFwib2c6aW1hZ2VcIiwgY29udGVudDogaW1hZ2UgfV0pXG5cbiAgICByZXR1cm4gaGVhZFxuICB9LFxuICB0cmFuc2Zvcm1QYWdlRGF0YShwYWdlRGF0YSkge1xuICAgIHBhZ2VEYXRhLmZyb250bWF0dGVyLmVkaXRMaW5rID0gcGFnZURhdGEucmVsYXRpdmVQYXRoLnN0YXJ0c1dpdGgoXCJkb2NzXCIpXG4gIH0sXG59KVxuIiwgImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvVXNlcnMva2V2aW4vRG9jdW1lbnRzL0VsZWN0cmljL2RldmVsb3BtZW50L2R1cmFibGUtc3RyZWFtcy9kb2NzLy52aXRlcHJlc3MvdGhlbWVcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9Vc2Vycy9rZXZpbi9Eb2N1bWVudHMvRWxlY3RyaWMvZGV2ZWxvcG1lbnQvZHVyYWJsZS1zdHJlYW1zL2RvY3MvLnZpdGVwcmVzcy90aGVtZS9tZXRhLWltYWdlLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy9rZXZpbi9Eb2N1bWVudHMvRWxlY3RyaWMvZGV2ZWxvcG1lbnQvZHVyYWJsZS1zdHJlYW1zL2RvY3MvLnZpdGVwcmVzcy90aGVtZS9tZXRhLWltYWdlLnRzXCI7LyoqXG4gKiBDaGVjayBpZiBhIFVSTCBpcyBhYnNvbHV0ZSAoc3RhcnRzIHdpdGggaHR0cDovLywgaHR0cHM6Ly8sIG9yIC8vKVxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNBYnNvbHV0ZVVybCh1cmw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gL14oaHR0cHM/Oik/XFwvXFwvLy50ZXN0KHVybClcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgZnVsbCBpbWFnZSBVUkwgZm9yIG1ldGEgdGFncy5cbiAqIElmIHRoZSBpbWFnZSBwYXRoIGlzIGFscmVhZHkgYW4gYWJzb2x1dGUgVVJMLCB1c2UgaXQgZGlyZWN0bHkuXG4gKiBPdGhlcndpc2UsIHByZWZpeCBpdCB3aXRoIHRoZSBzaXRlIG9yaWdpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRnVsbEltYWdlVXJsKFxuICBpbWFnZVBhdGg6IHN0cmluZyxcbiAgc2l0ZU9yaWdpbjogc3RyaW5nXG4pOiBzdHJpbmcge1xuICBpZiAoaXNBYnNvbHV0ZVVybChpbWFnZVBhdGgpKSB7XG4gICAgcmV0dXJuIGltYWdlUGF0aFxuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWRQYXRoID0gaW1hZ2VQYXRoLnN0YXJ0c1dpdGgoYC9gKSA/IGltYWdlUGF0aCA6IGAvJHtpbWFnZVBhdGh9YFxuICByZXR1cm4gYCR7c2l0ZU9yaWdpbn0ke25vcm1hbGl6ZWRQYXRofWBcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgTmV0bGlmeSBpbWFnZSBwcm94eSBVUkwgZm9yIG9wdGltaXplZCBtZXRhIGltYWdlcy5cbiAqIEFwcGxpZXMgZW5jb2RpbmcgYW5kIGltYWdlIHRyYW5zZm9ybWF0aW9uIHBhcmFtZXRlcnMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZE1ldGFJbWFnZVVybChcbiAgaW1hZ2VQYXRoOiBzdHJpbmcsXG4gIHNpdGVPcmlnaW46IHN0cmluZ1xuKTogc3RyaW5nIHtcbiAgY29uc3QgZnVsbEltYWdlVXJsID0gYnVpbGRGdWxsSW1hZ2VVcmwoaW1hZ2VQYXRoLCBzaXRlT3JpZ2luKVxuICByZXR1cm4gYCR7c2l0ZU9yaWdpbn0vLm5ldGxpZnkvaW1hZ2VzP3VybD0ke2VuY29kZVVSSUNvbXBvbmVudChmdWxsSW1hZ2VVcmwpfSZ3PTEyMDAmaD02MzAmZml0PWNvdmVyJmZtPWpwZyZxPTgwYFxufVxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUEyWSxTQUFTLG9CQUFvQjtBQUN4YSxPQUFPLGFBQWE7OztBQ0ViLFNBQVMsY0FBYyxLQUFzQjtBQUNsRCxTQUFPLGtCQUFrQixLQUFLLEdBQUc7QUFDbkM7QUFPTyxTQUFTLGtCQUNkLFdBQ0EsWUFDUTtBQUNSLE1BQUksY0FBYyxTQUFTLEdBQUc7QUFDNUIsV0FBTztBQUFBLEVBQ1Q7QUFDQSxRQUFNLGlCQUFpQixVQUFVLFdBQVcsR0FBRyxJQUFJLFlBQVksSUFBSSxTQUFTO0FBQzVFLFNBQU8sR0FBRyxVQUFVLEdBQUcsY0FBYztBQUN2QztBQU1PLFNBQVMsa0JBQ2QsV0FDQSxZQUNRO0FBQ1IsUUFBTSxlQUFlLGtCQUFrQixXQUFXLFVBQVU7QUFDNUQsU0FBTyxHQUFHLFVBQVUsd0JBQXdCLG1CQUFtQixZQUFZLENBQUM7QUFDOUU7OztBRDdCQSxJQUFPLGlCQUFRLGFBQWE7QUFBQSxFQUMxQixNQUFNO0FBQUEsSUFDSjtBQUFBLE1BQ0U7QUFBQSxNQUNBO0FBQUEsUUFDRSxLQUFLO0FBQUEsUUFDTCxNQUFNO0FBQUEsUUFDTixNQUFNO0FBQUEsTUFDUjtBQUFBLElBQ0Y7QUFBQSxJQUNBO0FBQUEsTUFDRTtBQUFBLE1BQ0E7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLFNBQVM7QUFBQSxNQUNYO0FBQUEsSUFDRjtBQUFBLElBQ0E7QUFBQSxNQUNFO0FBQUEsTUFDQTtBQUFBLFFBQ0UsT0FBTztBQUFBLFFBQ1AsZUFBZTtBQUFBLFFBQ2YsS0FBSztBQUFBLE1BQ1A7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsTUFBTTtBQUFBLElBQ0osU0FBUztBQUFBLE1BQ1AsUUFBUTtBQUFBLFFBQ04scUJBQXFCO0FBQUEsTUFDdkIsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGO0FBQUEsRUFDQSxNQUFNO0FBQUEsRUFDTixPQUFPO0FBQUEsRUFDUCxhQUNFO0FBQUEsRUFDRixZQUFZO0FBQUEsRUFDWixXQUFXO0FBQUEsRUFDWCxZQUFZLENBQUMsYUFBYSxhQUFhO0FBQUEsRUFDdkMsaUJBQWlCLENBQUMscUJBQXFCO0FBQUEsRUFDdkMsYUFBYTtBQUFBLElBQ1gsTUFBTTtBQUFBLElBQ04sS0FBSztBQUFBLE1BQ0gsRUFBRSxNQUFNLFFBQVEsTUFBTSxJQUFJO0FBQUEsTUFDMUIsRUFBRSxNQUFNLFFBQVEsTUFBTSxjQUFjO0FBQUEsTUFDcEM7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLE1BQU07QUFBQSxNQUNSO0FBQUEsSUFDRjtBQUFBLElBQ0EsU0FBUztBQUFBLE1BQ1A7QUFBQSxRQUNFLE1BQU07QUFBQSxRQUNOLE9BQU87QUFBQSxVQUNMLEVBQUUsTUFBTSxjQUFjLE1BQU0sY0FBYztBQUFBLFVBQzFDLEVBQUUsTUFBTSxpQkFBaUIsTUFBTSxZQUFZO0FBQUEsUUFDN0M7QUFBQSxNQUNGO0FBQUEsTUFDQTtBQUFBLFFBQ0UsTUFBTTtBQUFBLFFBQ04sT0FBTztBQUFBLFVBQ0wsRUFBRSxNQUFNLE9BQU8sTUFBTSxPQUFPO0FBQUEsVUFDNUI7QUFBQSxZQUNFLE1BQU07QUFBQSxZQUNOLE9BQU87QUFBQSxjQUNMLEVBQUUsTUFBTSxjQUFjLE1BQU0scUJBQXFCO0FBQUEsY0FDakQsRUFBRSxNQUFNLFVBQVUsTUFBTSxpQkFBaUI7QUFBQSxjQUN6QyxFQUFFLE1BQU0saUJBQWlCLE1BQU0sV0FBVztBQUFBLFlBQzVDO0FBQUEsWUFDQSxXQUFXO0FBQUEsVUFDYjtBQUFBLFVBQ0EsRUFBRSxNQUFNLGFBQWEsTUFBTSxhQUFhO0FBQUEsVUFDeEMsRUFBRSxNQUFNLGlCQUFpQixNQUFNLGlCQUFpQjtBQUFBLFVBQ2hELEVBQUUsTUFBTSxpQkFBaUIsTUFBTSxpQkFBaUI7QUFBQSxVQUNoRCxFQUFFLE1BQU0sWUFBWSxNQUFNLGFBQWE7QUFBQSxVQUN2QyxFQUFFLE1BQU0sWUFBWSxNQUFNLGFBQWE7QUFBQSxRQUN6QztBQUFBLE1BQ0Y7QUFBQSxNQUNBO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixPQUFPO0FBQUEsVUFDTCxFQUFFLE1BQU0sZUFBZSxNQUFNLGVBQWU7QUFBQSxVQUM1QyxFQUFFLE1BQU0saUJBQWlCLE1BQU0saUJBQWlCO0FBQUEsVUFDaEQ7QUFBQSxZQUNFLE1BQU07QUFBQSxZQUNOLE1BQU07QUFBQSxVQUNSO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxNQUNBO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixPQUFPO0FBQUEsVUFDTCxFQUFFLE1BQU0sY0FBYyxNQUFNLGNBQWM7QUFBQSxVQUMxQyxFQUFFLE1BQU0scUJBQXFCLE1BQU0scUJBQXFCO0FBQUEsVUFDeEQsRUFBRSxNQUFNLHFCQUFxQixNQUFNLHFCQUFxQjtBQUFBLFVBQ3hELEVBQUUsTUFBTSxnQkFBZ0IsTUFBTSxnQkFBZ0I7QUFBQSxVQUM5QztBQUFBLFlBQ0UsTUFBTTtBQUFBLFlBQ04sTUFBTTtBQUFBLFVBQ1I7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxJQUNBLGFBQWE7QUFBQSxNQUNYLEVBQUUsTUFBTSxXQUFXLE1BQU0sZ0NBQWdDO0FBQUEsTUFDekQsRUFBRSxNQUFNLEtBQUssTUFBTSwrQkFBK0I7QUFBQSxNQUNsRDtBQUFBLFFBQ0UsTUFBTTtBQUFBLFFBQ04sTUFBTTtBQUFBLE1BQ1I7QUFBQSxJQUNGO0FBQUEsSUFDQSxRQUFRO0FBQUEsTUFDTixVQUFVO0FBQUEsSUFDWjtBQUFBLElBQ0EsVUFBVTtBQUFBLE1BQ1IsU0FDRTtBQUFBLElBQ0o7QUFBQSxJQUNBLFFBQVE7QUFBQSxNQUNOLFdBQ0U7QUFBQSxNQUNGLFNBQ0U7QUFBQSxJQUNKO0FBQUEsRUFDRjtBQUFBLEVBQ0EsZUFBZSxDQUFDLEVBQUUsVUFBVSxTQUFTLE1BQU07QUFDekMsVUFBTSxLQUFLLFNBQVM7QUFDcEIsVUFBTSxPQUFPLENBQUM7QUFFZCxVQUFNLFlBQVksR0FBRyxTQUFTLFNBQVM7QUFDdkMsVUFBTSxnQkFBZ0IsR0FBRyxpQkFBaUI7QUFDMUMsVUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLFNBQVM7QUFDdkQsVUFBTSxjQUFjLEdBQUcsZUFBZSxTQUFTO0FBRS9DLFVBQU0saUJBQWlCO0FBQ3ZCLFVBQU0sZ0JBQWdCO0FBQ3RCLFVBQU0sZ0JBQWdCO0FBRXRCLFVBQU0sYUFDSixRQUFRLElBQUksWUFBWSxlQUNwQixRQUFRLElBQUksT0FBTyxpQkFDbkIsUUFBUSxJQUFJLHFCQUNYLFFBQVEsSUFBSSxhQUFhLGdCQUN0QixnQkFDQTtBQUVWLFVBQU0sUUFBUSxrQkFBa0IsR0FBRyxTQUFTLGVBQWUsVUFBVTtBQUVyRSxTQUFLLEtBQUs7QUFBQSxNQUNSO0FBQUEsTUFDQSxFQUFFLE1BQU0sZ0JBQWdCLFNBQVMsc0JBQXNCO0FBQUEsSUFDekQsQ0FBQztBQUNELFNBQUssS0FBSyxDQUFDLFFBQVEsRUFBRSxNQUFNLGdCQUFnQixTQUFTLGtCQUFrQixDQUFDLENBQUM7QUFDeEUsU0FBSyxLQUFLLENBQUMsUUFBUSxFQUFFLE1BQU0saUJBQWlCLFNBQVMsTUFBTSxDQUFDLENBQUM7QUFDN0QsU0FBSyxLQUFLLENBQUMsUUFBUSxFQUFFLE1BQU0sdUJBQXVCLFNBQVMsWUFBWSxDQUFDLENBQUM7QUFDekUsU0FBSyxLQUFLLENBQUMsUUFBUSxFQUFFLE1BQU0saUJBQWlCLFNBQVMsTUFBTSxDQUFDLENBQUM7QUFDN0QsU0FBSyxLQUFLLENBQUMsUUFBUSxFQUFFLFVBQVUsWUFBWSxTQUFTLE1BQU0sQ0FBQyxDQUFDO0FBQzVELFNBQUssS0FBSyxDQUFDLFFBQVEsRUFBRSxVQUFVLGtCQUFrQixTQUFTLFlBQVksQ0FBQyxDQUFDO0FBQ3hFLFNBQUssS0FBSyxDQUFDLFFBQVEsRUFBRSxVQUFVLFlBQVksU0FBUyxNQUFNLENBQUMsQ0FBQztBQUU1RCxXQUFPO0FBQUEsRUFDVDtBQUFBLEVBQ0Esa0JBQWtCLFVBQVU7QUFDMUIsYUFBUyxZQUFZLFdBQVcsU0FBUyxhQUFhLFdBQVcsTUFBTTtBQUFBLEVBQ3pFO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
