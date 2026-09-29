import { definePageRecipe, readPage } from "./page-recipe.js"

/** Front-page stories as `{id,title,url,points}`, read from the rendered DOM. */
const FRONT_PAGE_EXPR = `(() => [...document.querySelectorAll("tr.athing")].map(r => {
  const a = r.querySelector(".titleline > a");
  const sub = r.nextElementSibling;
  const score = sub && sub.querySelector(".score");
  return { id: r.id, title: a ? a.textContent : "", url: a ? a.href : null,
    points: score ? parseInt(score.textContent, 10) : 0 };
}))()`

export interface HackerNewsStory {
  id: string
  title: string
  url: string | null
  points: number
}

const SEED: HackerNewsStory[] = [
  { id: "1", title: "Show HN: A tiny browser server", url: "https://example.com/a", points: 210 },
  { id: "2", title: "Ask HN: What are you building?", url: null, points: 95 },
  { id: "3", title: "A note on process supervision", url: "https://example.com/c", points: 40 },
]

export const hackerNewsTop = definePageRecipe({
  id: "hackernews-top",
  name: "Hacker News front page",
  description:
    "Read the top stories from the Hacker News front page. Sample recipe: public page, no login.",
  inputs: [{ flag: "limit", doc: "Number of stories to return (default 10, max 30)." }],
  parseInput: flags => {
    const n = flags.limit ? Number(flags.limit) : 10
    if (!Number.isInteger(n) || n < 1 || n > 30)
      throw new Error("hackernews-top: `limit` must be an integer from 1 to 30")
    return { limit: n }
  },
  offlineSeed: SEED,
  read: async (page, input) => {
    await page.gotoPaced("https://news.ycombinator.com/")
    const rows = (await readPage<HackerNewsStory[]>(page, FRONT_PAGE_EXPR)) ?? []
    return { source: "news.ycombinator.com", stories: rows.slice(0, Number(input.limit)) }
  },
})
