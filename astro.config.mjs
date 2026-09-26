import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.walkingwithember.co.uk",
  output: "static",
  integrations: [
    sitemap({
      // /home-b/ is the B arm of the homepage A/B test — it is served at "/"
      // by the ab-home edge function and must never be indexed on its own.
      filter: (page) => !page.includes("/home-b"),
    }),
  ],
});
