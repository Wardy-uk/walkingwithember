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
      //  • /preview/ — unpublished drafts, still full of TODO prompts
      // Attach each walk's photographs to its sitemap entry. The images are
      // in the HTML now, so a crawler would find them eventually; this just
      // stops it being a matter of luck.
      serialize(item) {
        const m = /\/walks\/([^/]+)\/$/.exec(item.url);
        if (!m) return item;
        const date = m[1].slice(0, 10);
        const file = path.join("public", "photos", `${date}.json`);
        if (!fs.existsSync(file)) return item;
        try {
          const photos = JSON.parse(fs.readFileSync(file, "utf8")).photos ?? [];
          const imgs = photos.filter((p) => p?.src).map((p) => ({ url: new URL(p.src, item.url).href }));
          if (imgs.length) item.img = imgs;
        } catch {
          // A malformed manifest should cost the page its images, not the build.
        }
        return item;
      },
      filter: (page) =>
        !page.includes("/preview/") &&
        !NOINDEX_WALKS.some((slug) => page.includes(`/walks/${slug}/`)),
    }),
  ],
});
