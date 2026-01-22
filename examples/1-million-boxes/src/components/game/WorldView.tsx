export function WorldView() {
  return (
    <div
      className="world-view"
      data-testid="world-view"
      style={{
        position: `absolute`,
        bottom: `var(--minimap-margin)`,
        right: `var(--minimap-margin)`,
        width: `var(--minimap-size)`,
        height: `var(--minimap-size)`,
        background: `rgba(0, 0, 0, 0.7)`,
        borderRadius: `8px`,
        border: `2px solid white`,
      }}
    />
  )
}
