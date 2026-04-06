import { useEffect, useState } from "react"
import type { BrowserUser } from "~/lib/browser-user"
import { readBrowserUser, writeBrowserUser } from "~/lib/browser-user"

export function useBrowserUser() {
  const [user, setUser] = useState<BrowserUser>(() => readBrowserUser())

  useEffect(() => {
    writeBrowserUser(user)
  }, [user])

  return {
    user,
    setUser,
  }
}
