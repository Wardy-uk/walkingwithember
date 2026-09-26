import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.walkingwithember.co.uk",
  output: "static",
  integrations: [
    sitemap({
      // Keep out of search:
      //  • /home-b/ — the B arm of the homepage A/B test, served at "/"
      //  • /preview/ — unpublished drafts, still full of TODO prompts
      filter: (page) => !page.includes("/home-b") && !page.includes("/preview/"),
    }),
  ],
});
