import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TEAM_COLORS } from "../../lib/teams"
import { useTeam } from "../../contexts/team-context"
import { TeamBadge } from "./TeamBadge"
import type { TeamName } from "../../lib/teams"

// Mock the team context
vi.mock(`../../contexts/team-context`, () => ({
  useTeam: vi.fn(),
}))
const mockUseTeam = vi.mocked(useTeam)

describe(`TeamBadge`, () => {
  it(`displays team name with proper capitalization`, () => {
    mockUseTeam.mockReturnValue({
      team: `RED`,
      teamId: 0,
    })

    render(<TeamBadge />)

    expect(screen.getByTestId(`team-name`)).toHaveTextContent(`Red`)
  })

  it(`displays team ID with hash prefix`, () => {
    mockUseTeam.mockReturnValue({
      team: `BLUE`,
      teamId: 1,
    })

    render(<TeamBadge />)

    expect(screen.getByTestId(`team-id`)).toHaveTextContent(`#1`)
  })

  it(`displays correct color dot for RED team`, () => {
    mockUseTeam.mockReturnValue({
      team: `RED`,
      teamId: 0,
    })

    render(<TeamBadge />)

    const dot = screen.getByTestId(`team-color-dot`)
    expect(dot).toHaveStyle({ background: TEAM_COLORS.RED.primary })
  })

  it(`displays correct color dot for BLUE team`, () => {
    mockUseTeam.mockReturnValue({
      team: `BLUE`,
      teamId: 1,
    })

    render(<TeamBadge />)

    const dot = screen.getByTestId(`team-color-dot`)
    expect(dot).toHaveStyle({ background: TEAM_COLORS.BLUE.primary })
  })

  it(`displays correct color dot for GREEN team`, () => {
    mockUseTeam.mockReturnValue({
      team: `GREEN`,
      teamId: 2,
    })

    render(<TeamBadge />)

    const dot = screen.getByTestId(`team-color-dot`)
    expect(dot).toHaveStyle({ background: TEAM_COLORS.GREEN.primary })
  })

  it(`displays correct color dot for YELLOW team`, () => {
    mockUseTeam.mockReturnValue({
      team: `YELLOW`,
      teamId: 3,
    })

    render(<TeamBadge />)

    const dot = screen.getByTestId(`team-color-dot`)
    expect(dot).toHaveStyle({ background: TEAM_COLORS.YELLOW.primary })
  })

  it(`renders all team variations correctly`, () => {
    const teams: Array<{ team: TeamName; teamId: number; display: string }> = [
      { team: `RED`, teamId: 0, display: `Red` },
      { team: `BLUE`, teamId: 1, display: `Blue` },
      { team: `GREEN`, teamId: 2, display: `Green` },
      { team: `YELLOW`, teamId: 3, display: `Yellow` },
    ]

    for (const { team, teamId, display } of teams) {
      mockUseTeam.mockReturnValue({ team, teamId })

      const { unmount } = render(<TeamBadge />)

      expect(screen.getByTestId(`team-name`)).toHaveTextContent(display)
      expect(screen.getByTestId(`team-id`)).toHaveTextContent(`#${teamId}`)
      expect(screen.getByTestId(`team-color-dot`)).toHaveStyle({
        background: TEAM_COLORS[team].primary,
      })

      unmount()
    }
  })

  it(`has correct test IDs for accessibility`, () => {
    mockUseTeam.mockReturnValue({
      team: `RED`,
      teamId: 0,
    })

    render(<TeamBadge />)

    expect(screen.getByTestId(`team-badge`)).toBeInTheDocument()
    expect(screen.getByTestId(`team-color-dot`)).toBeInTheDocument()
    expect(screen.getByTestId(`team-name`)).toBeInTheDocument()
    expect(screen.getByTestId(`team-id`)).toBeInTheDocument()
  })
})
