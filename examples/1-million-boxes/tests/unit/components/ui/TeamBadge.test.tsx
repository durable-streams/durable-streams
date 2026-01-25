import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TEAM_COLORS } from "../../../../shared/teams"
import { useTeam } from "../../../../src/contexts/team-context"
import { TeamBadge } from "../../../../src/components/ui/TeamBadge"
import type { TeamName } from "../../../../shared/teams"

// Mock the team context
vi.mock(`../../../../src/contexts/team-context`, () => ({
  useTeam: vi.fn(),
}))
const mockUseTeam = vi.mocked(useTeam)

describe(`TeamBadge`, () => {
  it(`displays team name with proper capitalization`, () => {
    mockUseTeam.mockReturnValue({
      team: `RED`,
    })

    render(<TeamBadge />)

    expect(screen.getByTestId(`team-name`)).toHaveTextContent(`Red`)
  })

  it(`displays correct color dot for RED team`, () => {
    mockUseTeam.mockReturnValue({
      team: `RED`,
    })

    render(<TeamBadge />)

    const dot = screen.getByTestId(`team-color-dot`)
    expect(dot).toHaveStyle({ background: TEAM_COLORS.RED.primary })
  })

  it(`displays correct color dot for BLUE team`, () => {
    mockUseTeam.mockReturnValue({
      team: `BLUE`,
    })

    render(<TeamBadge />)

    const dot = screen.getByTestId(`team-color-dot`)
    expect(dot).toHaveStyle({ background: TEAM_COLORS.BLUE.primary })
  })

  it(`displays correct color dot for GREEN team`, () => {
    mockUseTeam.mockReturnValue({
      team: `GREEN`,
    })

    render(<TeamBadge />)

    const dot = screen.getByTestId(`team-color-dot`)
    expect(dot).toHaveStyle({ background: TEAM_COLORS.GREEN.primary })
  })

  it(`displays correct color dot for YELLOW team`, () => {
    mockUseTeam.mockReturnValue({
      team: `YELLOW`,
    })

    render(<TeamBadge />)

    const dot = screen.getByTestId(`team-color-dot`)
    expect(dot).toHaveStyle({ background: TEAM_COLORS.YELLOW.primary })
  })

  it(`renders all team variations correctly`, () => {
    const teams: Array<{ team: TeamName; display: string }> = [
      { team: `RED`, display: `Red Team` },
      { team: `BLUE`, display: `Blue Team` },
      { team: `GREEN`, display: `Green Team` },
      { team: `YELLOW`, display: `Yellow Team` },
    ]

    for (const { team, display } of teams) {
      mockUseTeam.mockReturnValue({ team })

      const { unmount } = render(<TeamBadge />)

      expect(screen.getByTestId(`team-name`)).toHaveTextContent(display)
      expect(screen.getByTestId(`team-color-dot`)).toHaveStyle({
        background: TEAM_COLORS[team].primary,
      })

      unmount()
    }
  })

  it(`has correct test IDs for accessibility`, () => {
    mockUseTeam.mockReturnValue({
      team: `RED`,
    })

    render(<TeamBadge />)

    expect(screen.getByTestId(`team-badge`)).toBeInTheDocument()
    expect(screen.getByTestId(`team-color-dot`)).toBeInTheDocument()
    expect(screen.getByTestId(`team-name`)).toBeInTheDocument()
  })
})
