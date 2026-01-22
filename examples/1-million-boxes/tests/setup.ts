import "@testing-library/jest-dom/vitest"

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
