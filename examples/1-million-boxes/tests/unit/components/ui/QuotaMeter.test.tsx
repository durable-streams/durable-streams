import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useQuota } from "../../../../src/contexts/quota-context"
import { QuotaMeter } from "../../../../src/components/ui/QuotaMeter"

// Mock the quota context
vi.mock(`../../../../src/contexts/quota-context`, () => ({
  useQuota: vi.fn(),
}))
const mockUseQuota = vi.mocked(useQuota)

describe(`QuotaMeter`, () => {
  it(`displays remaining quota and max`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 5,
      max: 8,
      refillIn: 7,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    expect(screen.getByTestId(`quota-text`)).toHaveTextContent(`5/8`)
  })

  it(`displays all 8 segments when full`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 8,
      max: 8,
      refillIn: 0,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    const segments = screen.getByTestId(`quota-segments`)
    expect(segments.children).toHaveLength(8)

    // All segments should be filled
    for (let i = 0; i < 8; i++) {
      const segment = screen.getByTestId(`quota-segment-${i}`)
      expect(segment).toHaveClass(`quota-segment-filled`)
    }
  })

  it(`displays correct number of filled segments`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 3,
      max: 8,
      refillIn: 5,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    // First 3 should be filled, rest empty
    for (let i = 0; i < 3; i++) {
      const segment = screen.getByTestId(`quota-segment-${i}`)
      expect(segment).toHaveClass(`quota-segment-filled`)
    }
    for (let i = 3; i < 8; i++) {
      const segment = screen.getByTestId(`quota-segment-${i}`)
      expect(segment).toHaveClass(`quota-segment-empty`)
    }
  })

  it(`applies full color class when remaining > 5`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 6,
      max: 8,
      refillIn: 0,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    const segment = screen.getByTestId(`quota-segment-0`)
    expect(segment).toHaveClass(`quota-full`)
  })

  it(`applies mid color class when remaining is 3-5`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 4,
      max: 8,
      refillIn: 5,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    const segment = screen.getByTestId(`quota-segment-0`)
    expect(segment).toHaveClass(`quota-mid`)
  })

  it(`applies low color class when remaining <= 2`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 2,
      max: 8,
      refillIn: 5,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    const segment = screen.getByTestId(`quota-segment-0`)
    expect(segment).toHaveClass(`quota-low`)
  })

  it(`shows recharging text when quota is empty`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 0,
      max: 8,
      refillIn: 7,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    expect(screen.getByTestId(`quota-text`)).toHaveTextContent(`Recharging...`)
    expect(screen.getByTestId(`quota-meter`)).toHaveClass(`quota-recharging`)
  })

  it(`shows refill timer when quota is not full`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 5,
      max: 8,
      refillIn: 7,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    expect(screen.getByTestId(`quota-refill`)).toHaveTextContent(`+1 in 7s`)
  })

  it(`does not show refill timer when quota is full`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 8,
      max: 8,
      refillIn: 0,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    expect(screen.queryByTestId(`quota-refill`)).not.toBeInTheDocument()
  })

  it(`has correct test IDs for accessibility`, () => {
    mockUseQuota.mockReturnValue({
      remaining: 8,
      max: 8,
      refillIn: 0,
      consume: vi.fn(),
      syncFromServer: vi.fn(),
      refund: vi.fn(),
      bonusCount: 0,
      bonusPosition: null,
      setBonusPosition: vi.fn(),
      clearBonus: vi.fn(),
      localBoxesCompleted: 0,
    })

    render(<QuotaMeter />)

    expect(screen.getByTestId(`quota-meter`)).toBeInTheDocument()
    expect(screen.getByTestId(`quota-segments`)).toBeInTheDocument()
    expect(screen.getByTestId(`quota-text`)).toBeInTheDocument()
  })
})
