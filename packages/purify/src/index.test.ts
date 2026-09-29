import { describe, it, expect } from "vitest"
import { purify } from "./index.js"

const ARTICLE_HTML = `<!doctype html><html lang="en"><head><title>Brand Positioning 101</title></head>
<body>
  <nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
  <header>Cookie banner — accept all?</header>
  <article>
    <h1>Brand Positioning 101</h1>
    <p>Positioning is the space your brand owns in a customer's mind.</p>
    <p>A sharp position makes every downstream decision easier.</p>
  </article>
  <footer>© 2026 Example Co. Subscribe to our newsletter!</footer>
</body></html>`

describe("purify", () => {
  it("extracts the main article as markdown, dropping nav/footer boilerplate", async () => {
    const { title, markdown } = await purify(
      ARTICLE_HTML,
      "https://example.com/post"
    )
    expect(title).toContain("Brand Positioning 101")
    expect(markdown).toContain("space your brand owns")
    expect(markdown).toContain("downstream decision")
    // boilerplate stripped
    expect(markdown).not.toContain("Subscribe to our newsletter")
    expect(markdown).not.toMatch(/Cookie banner/i)
  })

  it("throws on empty html (caller decides skip vs error)", async () => {
    await expect(purify("   ", "https://example.com")).rejects.toThrow(/empty/)
  })
})
