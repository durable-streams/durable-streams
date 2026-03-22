<template>
  <svg
    viewBox="0 0 720 420"
    width="100%"
    role="img"
    aria-label="Client conformance test architecture diagram"
    class="client-adapter-diagram"
  >
    <defs>
      <marker
        id="client-adapter-arrowhead"
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
      height="116"
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
      Test Runner (Node.js)
    </text>
    <text
      x="140"
      y="80"
      fill="currentColor"
      font-size="18"
      font-family="var(--vp-font-family-base)"
    >
      • YAML test cases
    </text>
    <text
      x="140"
      y="104"
      fill="currentColor"
      font-size="18"
      font-family="var(--vp-font-family-base)"
    >
      • Reference server
    </text>
    <text
      x="140"
      y="128"
      fill="currentColor"
      font-size="18"
      font-family="var(--vp-font-family-base)"
    >
      • Result validation
    </text>

    <line
      x1="360"
      y1="136"
      x2="360"
      y2="180"
      stroke="currentColor"
      stroke-width="1.5"
      marker-end="url(#client-adapter-arrowhead)"
    />
    <text
      x="382"
      y="165"
      fill="currentColor"
      font-size="16"
      font-family="var(--vp-font-family-base)"
    >
      stdin/stdout (JSON lines)
    </text>

    <rect
      x="110"
      y="192"
      width="500"
      height="116"
      rx="12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
    />
    <text
      x="360"
      y="220"
      text-anchor="middle"
      fill="currentColor"
      font-size="18"
      font-weight="600"
      font-family="var(--vp-font-family-base)"
    >
      Your Client Adapter
    </text>
    <text
      x="140"
      y="248"
      fill="currentColor"
      font-size="18"
      font-family="var(--vp-font-family-base)"
    >
      • Reads commands from stdin
    </text>
    <text
      x="140"
      y="272"
      fill="currentColor"
      font-size="18"
      font-family="var(--vp-font-family-base)"
    >
      • Calls your client SDK
    </text>
    <text
      x="140"
      y="296"
      fill="currentColor"
      font-size="18"
      font-family="var(--vp-font-family-base)"
    >
      • Writes results to stdout
    </text>

    <line
      x1="360"
      y1="308"
      x2="360"
      y2="352"
      stroke="currentColor"
      stroke-width="1.5"
      marker-end="url(#client-adapter-arrowhead)"
    />
    <text
      x="382"
      y="338"
      fill="currentColor"
      font-size="16"
      font-family="var(--vp-font-family-base)"
    >
      HTTP
    </text>

    <rect
      x="190"
      y="364"
      width="340"
      height="44"
      rx="12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
    />
    <text
      x="360"
      y="391"
      text-anchor="middle"
      fill="currentColor"
      font-size="18"
      font-weight="600"
      font-family="var(--vp-font-family-base)"
    >
      Reference Server
    </text>
  </svg>
</template>

<style scoped>
.client-adapter-diagram {
  color: var(--vp-c-text-1);
  display: block;
  height: auto;
  margin: 16px 0;
  max-width: 720px;
}
</style>
