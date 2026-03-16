<script setup>
const items = [
  {
    title: "CLI",
    details: "Create, read, append-to and tail streams",
    href: "/cli",
    icon: "terminal",
  },
  {
    title: "Clients",
    details:
      "TypeScript, Python and other languages",
    href: "/typescript-client",
    icon: "code",
  },
  {
    title: "TanStack AI",
    details:
      "Durable Session <span class=\"hide-at-md\">support</span> for TanStack AI apps",
    href: "/tanstack-ai",
    icon: "tanstack",
  },
  {
    title: "Vercel AI SDK",
    details:
      "Durable Transport <span class=\"hide-at-md\">adapter</span> for AI SDK apps",
    href: "/vercel-ai-sdk",
    icon: "vercel",
  },
  {
    title: "JSON streams",
    details:
      "Stream structured data using JSON messages",
    href: "/json-mode",
    icon: "json",
  },
  {
    title: "Durable State",
    details:
      "Sync structured state over durable streams",
    href: "/durable-state",
    icon: "layers",
  },
  {
    title: "StreamDB",
    details: "A type-safe, reactive database in a stream",
    href: "/stream-db",
    icon: "database",
  },
  {
    title: "StreamFS",
    details: "A filesystem real-time sync in a stream",
    href: "/stream-fs",
    icon: "folder",
  },
]
</script>

<template>
  <section class="home-feature-grid">
    <a
      v-for="item in items"
      :key="item.href"
      class="home-feature-card"
      :href="item.href"
    >
      <div class="home-feature-header">
        <div class="home-feature-icon" :data-icon="item.icon">
          <img
            v-if="item.icon === 'tanstack'"
            src="/img/icons/tanstack.svg"
            alt=""
            class="tanstack-icon"
          />
          <svg
            v-else-if="item.icon === 'terminal'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m4 17 6-5-6-5" />
            <path d="M12 19h8" />
          </svg>
          <svg
            v-else-if="item.icon === 'code'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m9 18-6-6 6-6" />
            <path d="m15 6 6 6-6 6" />
          </svg>
          <svg
            v-else-if="item.icon === 'json'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M8 4c-2 0-3 1-3 3v2c0 1.5-.5 2.5-2 3 1.5.5 2 1.5 2 3v2c0 2 1 3 3 3" />
            <path d="M16 4c2 0 3 1 3 3v2c0 1.5.5 2.5 2 3-1.5.5-2 1.5-2 3v2c0 2-1 3-3 3" />
            <path d="M11 9h2" />
            <path d="M11 15h2" />
            <path d="M11 12h2" />
          </svg>
          <svg
            v-else-if="item.icon === 'vercel'"
            class="vercel-icon"
            viewBox="0 0 76 65"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
          </svg>
          <svg
            v-else-if="item.icon === 'layers'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m12 4 8 4-8 4-8-4 8-4Z" />
            <path d="m4 12 8 4 8-4" />
            <path d="m4 16 8 4 8-4" />
          </svg>
          <svg
            v-else-if="item.icon === 'proxy'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="8" y="5" width="8" height="14" rx="2" />
            <path d="M3 9h5" />
            <path d="m5 7-2 2 2 2" />
            <path d="M16 15h5" />
            <path d="m19 13 2 2-2 2" />
          </svg>
          <svg
            v-else-if="item.icon === 'folder'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z" />
          </svg>
          <svg
            v-else-if="item.icon === 'database'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
            <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
          </svg>
        </div>
        <h2>{{ item.title }}</h2>
      </div>
      <p v-html="item.details" />
      <span class="home-feature-link">Open guide</span>
    </a>
  </section>
</template>

<style scoped>
.home-feature-grid {
  display: grid;
  gap: 24px;
  margin: 22px auto 46px;
}

.home-feature-card {
  background: var(--vp-c-bg-soft);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 18px;
  color: inherit;
  display: flex;
  flex-direction: column;
  padding: 24px 26px 22px;
  text-decoration: none;
  transition:
    border-color 0.18s ease,
    transform 0.18s ease;
}

.home-feature-card:hover {
  border-color: rgba(117, 251, 253, 0.45);
  transform: translateY(-2px);
}

.home-feature-header {
  align-items: center;
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.home-feature-header h2 {
  border-top: 0 !important;
  font-size: 18px;
  line-height: 1.15;
  margin: 0;
  padding-top: 0 !important;
}

.home-feature-icon {
  align-items: center;
  color: var(--durable-color);
  display: inline-flex;
  flex: 0 0 auto;
  height: 28px;
  width: 28px;
  justify-content: center;
}

.home-feature-icon img,
.home-feature-icon svg {
  display: block;
  height: 38px;
  width: 38px;
}

.home-feature-icon[data-icon="tanstack"] img {
  border-radius: 999px;
}

.home-feature-icon[data-icon="vercel"] {
  color: #fff;
}

.home-feature-icon[data-icon="vercel"] svg {
  height: 28px;
  width: 28px;
}

.home-feature-card p {
  color: var(--vp-c-text-2);
  font-size: 15px;
  font-weight: 500;
  line-height: 1.55;
  margin: 0 0 14px;
}
.home-feature-link {
  color: var(--durable-color);
  font-weight: 500;
  margin-top: 6px;
  font-size: 14px;
}

.home-feature-link::after {
  content: " →";
}

@media (min-width: 768px) {
  .home-feature-grid {
    grid-template-columns: 1fr 1fr;
  }
}
@media (min-width: 768px) and (max-width: 920px) {
  .home-feature-card p {
    max-width: 200px;
  }
}
@media (min-width: 1100px) {
  .home-feature-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .home-feature-card p {
    max-width: 200px;
  }
}

.tanstack-icon {
  transform: scale(1.2);
}

.vercel-icon {
  transform: scale(0.8);
}
</style>
<style>
.hide-at-md {
  display: inline;
}
@media (min-width: 1100px) and (max-width: 1200px){
  .hide-at-md {
    display: none;
  }
}
</style>
