<template>
  <svg
    viewBox="0 0 720 258"
    width="100%"
    role="img"
    aria-label="Server conformance test architecture diagram"
    class="server-conformance-diagram"
  >
    <defs>
      <marker
        id="server-conformance-arrowhead"
        markerWidth="10"
        markerHeight="10"
        refX="6"
        refY="5"
        orient="auto"
      >
        <path d="M0,0 L0,10 L8,5 z" fill="currentColor" />
      </marker>
    </defs>

    <rect
      x="110"
      y="20"
      width="500"
      height="120"
      rx="12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
    />
    <text
      x="360"
      y="48"
      text-anchor="middle"
      fill="currentColor"
      font-size="18"
      font-weight="600"
      font-family="var(--vp-font-family-base)"
    >
      Test Runner (vitest)
    </text>
    <text
      x="140"
      y="78"
      fill="currentColor"
      font-size="18"
      font-family="var(--vp-font-family-base)"
    >
      • 232 protocol tests
    </text>
    <text
      x="140"
      y="102"
      fill="currentColor"
      font-size="18"
      font-family="var(--vp-font-family-base)"
    >
      • Property-based fuzzing
    </text>
    <text
      x="140"
      y="126"
      fill="currentColor"
      font-size="18"
      font-family="var(--vp-font-family-base)"
    >
      • Direct HTTP assertions
    </text>

    <line
      x1="360"
      y1="140"
      x2="360"
      y2="184"
      stroke="currentColor"
      stroke-width="1.5"
      marker-end="url(#server-conformance-arrowhead)"
    />
    <text
      x="382"
      y="169"
      fill="currentColor"
      font-size="16"
      font-family="var(--vp-font-family-base)"
    >
      HTTP (fetch)
    </text>

    <rect
      x="190"
      y="196"
      width="340"
      height="42"
      rx="12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
    />
    <text
      x="360"
      y="222"
      text-anchor="middle"
      fill="currentColor"
      font-size="18"
      font-weight="600"
      font-family="var(--vp-font-family-base)"
    >
      Your Server
    </text>
  </svg>
</template>

<style scoped>
.server-conformance-diagram {
  color: var(--vp-c-text-1);
  display: block;
  height: auto;
  margin: 16px 0;
  max-width: 720px;
}
</style>
