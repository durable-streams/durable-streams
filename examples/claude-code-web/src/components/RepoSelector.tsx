import { useState, useEffect, useCallback } from "react"
import type { GitHubRepo } from "~/lib/types"
import clsx from "clsx"

interface RepoSelectorProps {
  onSelect: (repo: GitHubRepo, branch?: string) => void
  onCancel: () => void
}

export function RepoSelector({ onSelect, onCancel }: RepoSelectorProps) {
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [selectedBranch, setSelectedBranch] = useState<string>("")
  const [loadingBranches, setLoadingBranches] = useState(false)

  // Fetch repositories
  useEffect(() => {
    async function fetchRepos() {
      try {
        const response = await fetch("/api/repos")
        if (!response.ok) {
          throw new Error("Failed to fetch repositories")
        }
        const data = await response.json()
        setRepos(data.repos)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load repos")
      } finally {
        setLoading(false)
      }
    }
    fetchRepos()
  }, [])

  // Fetch branches when repo is selected
  const fetchBranches = useCallback(async (repo: GitHubRepo) => {
    setLoadingBranches(true)
    try {
      const response = await fetch(
        `/api/repos/${repo.owner.login}/${repo.name}/branches`
      )
      if (!response.ok) {
        throw new Error("Failed to fetch branches")
      }
      const data = await response.json()
      setBranches(data.branches.map((b: { name: string }) => b.name))
      setSelectedBranch(repo.defaultBranch)
    } catch (err) {
      console.error("Failed to fetch branches:", err)
      setBranches([repo.defaultBranch])
      setSelectedBranch(repo.defaultBranch)
    } finally {
      setLoadingBranches(false)
    }
  }, [])

  const handleRepoSelect = (repo: GitHubRepo) => {
    setSelectedRepo(repo)
    fetchBranches(repo)
  }

  const handleConfirm = () => {
    if (selectedRepo) {
      onSelect(
        selectedRepo,
        selectedBranch !== selectedRepo.defaultBranch ? selectedBranch : undefined
      )
    }
  }

  // Filter repos by search
  const filteredRepos = repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(search.toLowerCase()) ||
      repo.fullName.toLowerCase().includes(search.toLowerCase())
  )

  if (loading) {
    return (
      <div className="repo-selector">
        <div className="repo-selector-loading">Loading repositories...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="repo-selector">
        <div className="repo-selector-error">{error}</div>
        <button onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div className="repo-selector">
      <div className="repo-selector-header">
        <h3>Select Repository</h3>
        <button onClick={onCancel} className="close-btn">
          &times;
        </button>
      </div>

      <input
        type="text"
        placeholder="Search repositories..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="repo-search"
        autoFocus
      />

      <ul className="repo-list">
        {filteredRepos.map((repo) => (
          <li key={repo.id}>
            <button
              className={clsx("repo-item", {
                selected: selectedRepo?.id === repo.id,
              })}
              onClick={() => handleRepoSelect(repo)}
            >
              <span className="repo-name">{repo.fullName}</span>
              {repo.description && (
                <span className="repo-description">{repo.description}</span>
              )}
              <span className="repo-meta">
                {repo.private ? "Private" : "Public"} &bull; Updated{" "}
                {new Date(repo.updatedAt).toLocaleDateString()}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selectedRepo && (
        <div className="branch-selector">
          <label htmlFor="branch-select">Branch:</label>
          {loadingBranches ? (
            <span>Loading branches...</span>
          ) : (
            <select
              id="branch-select"
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
            >
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                  {branch === selectedRepo.defaultBranch && " (default)"}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className="repo-selector-actions">
        <button onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={!selectedRepo}
          className="btn-primary"
        >
          Create Session
        </button>
      </div>
    </div>
  )
}
