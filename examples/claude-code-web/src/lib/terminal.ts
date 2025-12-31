import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"

export interface TerminalInstance {
  terminal: Terminal
  write: (data: string | Uint8Array) => void
  onData: (callback: (data: string) => void) => () => void
  onResize: (callback: (cols: number, rows: number) => void) => () => void
  onPaste: (callback: (text: string) => void) => () => void
  dispose: () => void
  focus: () => void
  fit: () => void
  getDimensions: () => { cols: number; rows: number }
}

// Claude Code branded theme - dark with subtle blue accents
const claudeTheme = {
  foreground: "#e4e4e7",
  background: "#18181b",
  cursor: "#a78bfa",
  cursorAccent: "#18181b",
  selectionBackground: "rgba(167, 139, 250, 0.3)",
  selectionForeground: "#ffffff",
  black: "#27272a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fcd34d",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
}

export function createTerminal(
  container: HTMLElement,
  options?: {
    fontSize?: number
    fontFamily?: string
  }
): TerminalInstance {
  const terminal = new Terminal({
    fontSize: options?.fontSize ?? 14,
    fontFamily:
      options?.fontFamily ?? "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
    scrollback: 10000,
    cursorBlink: true,
    cursorStyle: "block",
    theme: claudeTheme,
    allowProposedApi: true,
  })

  // Load addons
  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.loadAddon(new WebLinksAddon())

  // Open terminal
  terminal.open(container)

  // Initial fit
  fitAddon.fit()

  // Set up ResizeObserver for automatic resizing
  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit()
  })
  resizeObserver.observe(container)

  // Track paste callbacks (paste is handled at container level)
  const pasteCallbacks: Array<(text: string) => void> = []

  // Handle paste events at container level
  const handlePaste = (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData?.getData("text")
    if (text) {
      pasteCallbacks.forEach((cb) => cb(text))
    }
  }
  container.addEventListener("paste", handlePaste)

  return {
    terminal,
    write: (data: string | Uint8Array) => {
      terminal.write(data)
    },
    onData: (callback: (data: string) => void) => {
      const disposable = terminal.onData(callback)
      return () => disposable.dispose()
    },
    onResize: (callback: (cols: number, rows: number) => void) => {
      const disposable = terminal.onResize(({ cols, rows }) => {
        callback(cols, rows)
      })
      return () => disposable.dispose()
    },
    onPaste: (callback: (text: string) => void) => {
      pasteCallbacks.push(callback)
      return () => {
        const index = pasteCallbacks.indexOf(callback)
        if (index !== -1) pasteCallbacks.splice(index, 1)
      }
    },
    dispose: () => {
      resizeObserver.disconnect()
      container.removeEventListener("paste", handlePaste)
      terminal.dispose()
    },
    focus: () => {
      terminal.focus()
    },
    fit: () => {
      fitAddon.fit()
    },
    getDimensions: () => ({
      cols: terminal.cols,
      rows: terminal.rows,
    }),
  }
}
