import type { GitHubRepo } from "./types"

/**
 * GitHub API client for repository operations
 */

export interface GitHubApiOptions {
  token: string
  baseUrl?: string
}

export class GitHubClient {
  private token: string
  private baseUrl: string

  constructor(options: GitHubApiOptions) {
    this.token = options.token
    this.baseUrl = options.baseUrl || "https://api.github.com"
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`GitHub API error: ${response.status} - ${error}`)
    }

    return response.json()
  }

  /**
   * List repositories the authenticated user has access to
   */
  async listRepositories(options?: {
    visibility?: "all" | "public" | "private"
    sort?: "created" | "updated" | "pushed" | "full_name"
    direction?: "asc" | "desc"
    perPage?: number
    page?: number
  }): Promise<GitHubRepo[]> {
    const params = new URLSearchParams()
    if (options?.visibility) params.set("visibility", options.visibility)
    if (options?.sort) params.set("sort", options.sort)
    if (options?.direction) params.set("direction", options.direction)
    if (options?.perPage) params.set("per_page", String(options.perPage))
    if (options?.page) params.set("page", String(options.page))

    const query = params.toString()
    const path = `/user/repos${query ? `?${query}` : ""}`

    const repos = await this.request<
      Array<{
        id: number
        name: string
        full_name: string
        owner: { login: string; avatar_url?: string }
        description: string | null
        private: boolean
        default_branch: string
        clone_url: string
        html_url: string
        updated_at: string
      }>
    >(path)

    return repos.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: {
        login: repo.owner.login,
        avatarUrl: repo.owner.avatar_url,
      },
      description: repo.description,
      private: repo.private,
      defaultBranch: repo.default_branch,
      cloneUrl: repo.clone_url,
      htmlUrl: repo.html_url,
      updatedAt: repo.updated_at,
    }))
  }

  /**
   * Get a specific repository
   */
  async getRepository(owner: string, repo: string): Promise<GitHubRepo> {
    const data = await this.request<{
      id: number
      name: string
      full_name: string
      owner: { login: string; avatar_url?: string }
      description: string | null
      private: boolean
      default_branch: string
      clone_url: string
      html_url: string
      updated_at: string
    }>(`/repos/${owner}/${repo}`)

    return {
      id: data.id,
      name: data.name,
      fullName: data.full_name,
      owner: {
        login: data.owner.login,
        avatarUrl: data.owner.avatar_url,
      },
      description: data.description,
      private: data.private,
      defaultBranch: data.default_branch,
      cloneUrl: data.clone_url,
      htmlUrl: data.html_url,
      updatedAt: data.updated_at,
    }
  }

  /**
   * List branches for a repository
   */
  async listBranches(
    owner: string,
    repo: string,
    options?: { perPage?: number; page?: number }
  ): Promise<Array<{ name: string; protected: boolean }>> {
    const params = new URLSearchParams()
    if (options?.perPage) params.set("per_page", String(options.perPage))
    if (options?.page) params.set("page", String(options.page))

    const query = params.toString()
    const path = `/repos/${owner}/${repo}/branches${query ? `?${query}` : ""}`

    return this.request(path)
  }

  /**
   * Get the authenticated user
   */
  async getUser(): Promise<{
    login: string
    name: string | null
    avatarUrl: string
  }> {
    const data = await this.request<{
      login: string
      name: string | null
      avatar_url: string
    }>("/user")

    return {
      login: data.login,
      name: data.name,
      avatarUrl: data.avatar_url,
    }
  }

  /**
   * Search repositories
   */
  async searchRepositories(
    query: string,
    options?: { perPage?: number; page?: number }
  ): Promise<{ totalCount: number; repos: GitHubRepo[] }> {
    const params = new URLSearchParams()
    params.set("q", query)
    if (options?.perPage) params.set("per_page", String(options.perPage))
    if (options?.page) params.set("page", String(options.page))

    const data = await this.request<{
      total_count: number
      items: Array<{
        id: number
        name: string
        full_name: string
        owner: { login: string; avatar_url?: string }
        description: string | null
        private: boolean
        default_branch: string
        clone_url: string
        html_url: string
        updated_at: string
      }>
    }>(`/search/repositories?${params.toString()}`)

    return {
      totalCount: data.total_count,
      repos: data.items.map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: {
          login: repo.owner.login,
          avatarUrl: repo.owner.avatar_url,
        },
        description: repo.description,
        private: repo.private,
        defaultBranch: repo.default_branch,
        cloneUrl: repo.clone_url,
        htmlUrl: repo.html_url,
        updatedAt: repo.updated_at,
      })),
    }
  }
}

/**
 * Create a GitHub client from environment
 */
export function createGitHubClient(token: string): GitHubClient {
  return new GitHubClient({ token })
}
