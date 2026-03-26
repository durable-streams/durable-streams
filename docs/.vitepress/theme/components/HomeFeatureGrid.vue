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
    details: "TypeScript, Python and other languages",
    href: "/typescript-client",
    icon: "code",
  },
  {
    title: "TanStack AI",
    details:
      'Durable Session <span class="hide-at-md">support</span> for TanStack AI apps',
    href: "/tanstack-ai",
    icon: "tanstack",
  },
  {
    title: "Vercel AI SDK",
    details:
      'Durable Transport <span class="hide-at-md">adapter</span> for AI SDK apps',
    href: "/vercel-ai-sdk",
    icon: "vercel",
  },
  {
    title: "JSON mode",
    details: "Stream structured data using JSON messages",
    href: "/json-mode",
    icon: "json",
  },
  {
    title: "StreamDB",
    details: "A type-safe, reactive database in a stream",
    href: "/stream-db",
    icon: "database",
  },
  {
    title: "StreamFS",
    details: "A reactive agent filesystem in a stream",
    href: "/stream-fs",
    icon: "folder",
  },
  {
    title: "Yjs",
    details: "Yjs provider for collaborative editing",
    href: "/yjs",
    icon: "yjs",
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
            <path
              d="M8 4c-2 0-3 1-3 3v2c0 1.5-.5 2.5-2 3 1.5.5 2 1.5 2 3v2c0 2 1 3 3 3"
            />
            <path
              d="M16 4c2 0 3 1 3 3v2c0 1.5.5 2.5 2 3-1.5.5-2 1.5-2 3v2c0 2-1 3-3 3"
            />
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
            <path
              d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-10Z"
            />
          </svg>
          <svg
            v-else-if="item.icon === 'collab'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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
            <ellipse cx="12" cy="7" rx="8" ry="2.5" />
            <path d="M4 7v12c0 1.38 3.58 2.5 8 2.5s8-1.12 8-2.5V7" />
            <path d="M4 13c0 1.38 3.58 2.5 8 2.5s8-1.12 8-2.5" />
          </svg>
          <svg
            v-else-if="item.icon === 'yjs'"
            viewBox="0 0 90 90"
          >
            <rect x="13" y="2" width="64.8772" height="86" fill="url(#pattern0_882_138)"/>
            <defs>
            <pattern id="pattern0_882_138" patternContentUnits="objectBoundingBox" width="1" height="1">
            <use xlink:href="#image0_882_138" transform="scale(0.0232558 0.0175439)"/>
            </pattern>
            <image id="image0_882_138" width="43" height="57" xlink:href="data:image/png;base64,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"/>
            </defs>
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
@media (min-width: 1100px) and (max-width: 1200px) {
  .hide-at-md {
    display: none;
  }
}
</style>
