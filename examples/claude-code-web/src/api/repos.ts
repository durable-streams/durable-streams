import { createServerFn } from "@tanstack/start"
import { z } from "zod"
import { createGitHubClient } from "~/lib/github"
import { getEnvConfig } from "~/lib/env"

// List repositories for the authenticated user
export const getRepos = createServerFn({ method: "GET" }).handler(async () => {
  const env = getEnvConfig()
  const github = createGitHubClient(env.githubToken)

  const repos = await github.listRepositories({
    sort: "updated",
    direction: "desc",
    perPage: 100,
  })

  return { repos }
})

// Get a specific repository
export const getRepo = createServerFn({ method: "GET" })
  .validator(z.object({ owner: z.string(), repo: z.string() }))
  .handler(async ({ data }) => {
    const env = getEnvConfig()
    const github = createGitHubClient(env.githubToken)

    const repo = await github.getRepository(data.owner, data.repo)

    return { repo }
  })

// List branches for a repository
export const getRepoBranches = createServerFn({ method: "GET" })
  .validator(z.object({ owner: z.string(), repo: z.string() }))
  .handler(async ({ data }) => {
    const env = getEnvConfig()
    const github = createGitHubClient(env.githubToken)

    const branches = await github.listBranches(data.owner, data.repo, {
      perPage: 100,
    })

    return { branches }
  })

// Search repositories
export const searchRepos = createServerFn({ method: "GET" })
  .validator(z.object({ query: z.string(), page: z.number().optional() }))
  .handler(async ({ data }) => {
    const env = getEnvConfig()
    const github = createGitHubClient(env.githubToken)

    const result = await github.searchRepositories(data.query, {
      perPage: 30,
      page: data.page,
    })

    return result
  })

// Get authenticated user info
export const getUser = createServerFn({ method: "GET" }).handler(async () => {
  const env = getEnvConfig()
  const github = createGitHubClient(env.githubToken)

  const user = await github.getUser()

  return { user }
})
