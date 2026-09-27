import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import fs from "node:fs";
import path from "node:path";

/**
 * Walks with no write-up yet render a "coming soon" page and set noindex.
 * Read straight from the content files so the sitemap cannot drift from what
 * the pages actually declare.
 */
const WALK_DIR = "src/content/walks";
const NOINDEX_WALKS = fs
  .readdirSync(WALK_DIR)
  .filter((f) => f.endsWith(".md"))
  .filter((f) => !/^writeupStatus: reviewed$/m.test(fs.readFileSync(path.join(WALK_DIR, f), "utf8")))
  .map((f) => f.replace(/\.md$/, ""));

export default defineConfig({
  site: "https://walkingwithember.co.uk",
  output: "static",
  integrations: [
    sitemap({
      // Keep out of search:
      //  • /home-b/ — the B arm of the homepage A/B test, served at "/"
      //  • /preview/ — unpublished drafts, still full of TODO prompts
      filter: (page) =>
        !page.includes("/home-b") &&
        !page.includes("/preview/") &&
        !NOINDEX_WALKS.some((slug) => page.includes(`/walks/${slug}/`)),
    }),
  ],
});
