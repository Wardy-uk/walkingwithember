import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.walkingwithember.co.uk",
  output: "static",
  integrations: [sitemap()],
});

