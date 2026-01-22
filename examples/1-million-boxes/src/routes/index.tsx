import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute(`/`)({
  component: IndexComponent,
})

function IndexComponent() {
  return (
    <div
      style={{
        display: `flex`,
        flexDirection: `column`,
        alignItems: `center`,
        justifyContent: `center`,
        height: `100%`,
        gap: `1rem`,
        padding: `2rem`,
        textAlign: `center`,
      }}
    >
      <h1 style={{ fontSize: `2.5rem`, fontWeight: 700 }}>1 Million Boxes</h1>
      <p style={{ color: `var(--color-muted)`, maxWidth: `32rem` }}>
        A global, finite, realtime game of Dots &amp; Boxes on a 1000×1000 grid.
        Four teams race to claim the most boxes.
      </p>
      <div
        style={{
          display: `flex`,
          gap: `0.5rem`,
          marginTop: `1rem`,
        }}
      >
        <span
          style={{
            display: `inline-block`,
            width: 24,
            height: 24,
            borderRadius: `var(--radius-sm)`,
            backgroundColor: `var(--color-red)`,
          }}
        />
        <span
          style={{
            display: `inline-block`,
            width: 24,
            height: 24,
            borderRadius: `var(--radius-sm)`,
            backgroundColor: `var(--color-blue)`,
          }}
        />
        <span
          style={{
            display: `inline-block`,
            width: 24,
            height: 24,
            borderRadius: `var(--radius-sm)`,
            backgroundColor: `var(--color-green)`,
          }}
        />
        <span
          style={{
            display: `inline-block`,
            width: 24,
            height: 24,
            borderRadius: `var(--radius-sm)`,
            backgroundColor: `var(--color-yellow)`,
          }}
        />
      </div>
      <p style={{ color: `var(--color-muted)`, fontSize: `0.875rem` }}>
        Game coming soon...
      </p>
    </div>
  )
}
