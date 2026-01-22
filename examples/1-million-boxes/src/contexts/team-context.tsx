import { createContext, useContext } from "react"
import type { ReactNode } from "react"
import type { TeamName } from "../lib/teams"

export interface TeamContextValue {
  team: TeamName
  teamId: number
}

const TeamContext = createContext<TeamContextValue | null>(null)

export interface TeamProviderProps {
  children: ReactNode
  team: TeamName
  teamId: number
}

export function TeamProvider({ children, team, teamId }: TeamProviderProps) {
  return (
    <TeamContext.Provider value={{ team, teamId }}>
      {children}
    </TeamContext.Provider>
  )
}

export function useTeam(): TeamContextValue {
  const ctx = useContext(TeamContext)
  if (!ctx) {
    throw new Error(`useTeam must be used within TeamProvider`)
  }
  return ctx
}
