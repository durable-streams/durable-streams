export interface BrowserUser {
  name: string
  email: string
}

const NAME_KEY = `coding-agents-ui:name`
const EMAIL_KEY = `coding-agents-ui:email`

function randomLabel(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 6)}`
}

export function readBrowserUser(): BrowserUser {
  if (typeof window === `undefined`) {
    return {
      name: `operator`,
      email: `operator@example.com`,
    }
  }

  const storedName = localStorage.getItem(NAME_KEY)
  const storedEmail = localStorage.getItem(EMAIL_KEY)

  if (storedName && storedEmail) {
    return {
      name: storedName,
      email: storedEmail,
    }
  }

  const user = {
    name: randomLabel(`operator`),
    email: `${randomLabel(`user`)}@local.example`,
  }

  localStorage.setItem(NAME_KEY, user.name)
  localStorage.setItem(EMAIL_KEY, user.email)

  return user
}

export function writeBrowserUser(user: BrowserUser): void {
  localStorage.setItem(NAME_KEY, user.name)
  localStorage.setItem(EMAIL_KEY, user.email)
}
