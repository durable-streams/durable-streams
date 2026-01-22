import { expect } from "vitest"
import * as matchers from "@testing-library/jest-dom/matchers"

expect.extend(matchers)

// Mock localStorage for tests
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
}

Object.defineProperty(globalThis, `localStorage`, {
  value: localStorageMock,
  writable: true,
})

// Mock matchMedia for tests
Object.defineProperty(window, `matchMedia`, {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock ResizeObserver for tests
class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

Object.defineProperty(globalThis, `ResizeObserver`, {
  value: ResizeObserverMock,
  writable: true,
})

// Mock navigator.vibrate for tests
Object.defineProperty(navigator, `vibrate`, {
  value: vi.fn().mockReturnValue(true),
  writable: true,
})
