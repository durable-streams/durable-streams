import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"

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

// CRT phosphor green theme
const crtTheme = {
  foreground: `#33ff33`,
  background: `#0a0a0a`,
  cursor: `#33ff33`,
  cursorAccent: `#0a0a0a`,
  selectionBackground: `rgba(51, 255, 51, 0.3)`,
  selectionForeground: `#ffffff`,
  black: `#0a0a0a`,
  red: `#ff3333`,
  green: `#33ff33`,
  yellow: `#ffb000`,
  blue: `#3399ff`,
  magenta: `#ff33ff`,
  cyan: `#33ffff`,
  white: `#cccccc`,
  brightBlack: `#666666`,
  brightRed: `#ff6666`,
  brightGreen: `#66ff66`,
  brightYellow: `#ffcc33`,
  brightBlue: `#66b3ff`,
  brightMagenta: `#ff66ff`,
  brightCyan: `#66ffff`,
  brightWhite: `#ffffff`,
}

export function createTerminal(
  container: HTMLElement,
  options?: {
    fontSize?: number
    fontFamily?: string
  }
): TerminalInstance {
  const terminal = new Terminal({
    fontSize: options?.fontSize ?? 15,
    fontFamily:
      options?.fontFamily ?? `'JetBrains Mono', 'Fira Code', monospace`,
    scrollback: 10000,
    cursorBlink: true,
    cursorStyle: `block`,
    theme: crtTheme,
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

  // Track paste callbacks
  const pasteCallbacks: Array<(text: string) => void> = []

  // Handle paste events
  const handlePaste = (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData?.getData(`text`)
    if (text) {
      pasteCallbacks.forEach((cb) => cb(text))
    }
  }
  container.addEventListener(`paste`, handlePaste)

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
      container.removeEventListener(`paste`, handlePaste)
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
