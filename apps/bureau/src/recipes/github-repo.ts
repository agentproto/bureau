import { definePageRecipe, readPage } from "./page-recipe.js"

export interface GithubRepoSummary {
  fullName: string
  description: string | null
  stars: number
  forks: number
  openIssues: number
  language: string | null
  license: string | null
  pushedAt: string | null
  url: string
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

const repoExpr = (repo: string): string => `fetch(${JSON.stringify(
  `https://api.github.com/repos/${repo}`
)}).then(r => r.json()).then(j => ({
  fullName: j.full_name, description: j.description, stars: j.stargazers_count,
  forks: j.forks_count, openIssues: j.open_issues_count, language: j.language,
  license: j.license ? j.license.spdx_id : null, pushedAt: j.pushed_at, url: j.html_url }))`

const SEED: GithubRepoSummary = {
  fullName: "octocat/hello-world",
  description: "My first repository",
  stars: 1234,
  forks: 56,
  openIssues: 7,
  language: "TypeScript",
  license: "MIT",
  pushedAt: "2026-01-01T00:00:00Z",
  url: "https://github.com/octocat/hello-world",
}

export const githubRepo = definePageRecipe({
  id: "github-repo",
  name: "GitHub repository summary",
  description:
    "Summarise a public GitHub repository (stars, forks, language, license). Sample recipe: public data, no login.",
  inputs: [{ flag: "repo", doc: "Repository as owner/name.", required: true }],
  parseInput: flags => {
    if (!flags.repo || !REPO.test(flags.repo))
      throw new Error("github-repo: `repo` must look like owner/name")
    return { repo: flags.repo }
  },
  offlineSeed: SEED,
  read: async (page, input) => {
    const repo = String(input.repo)
    await page.navigate(`https://github.com/${repo}`)
    const summary = await readPage<GithubRepoSummary>(page, repoExpr(repo))
    if (!summary) throw new Error(`github-repo: no data returned for ${repo}`)
    return summary
  },
})
