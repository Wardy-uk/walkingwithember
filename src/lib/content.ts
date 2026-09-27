import { getCollection } from "astro:content";

export async function getSiteSettings() {
  const settings = await getCollection("settings");
  return settings[0]?.data ?? {
    siteName: "Walking with Ember",
    tagline: "UK hiking routes, trail notes, and honest hill days out",
    baseUrl: "https://example.com",
    social: {},
    homepage: {
      mastheadImage: "/uploads/images/5da590c5-0884-4c1c-8fc1-012850f889fa-61fec1bcfa.jpg",
      galleryImages: ["/uploads/images/5da590c5-0884-4c1c-8fc1-012850f889fa-80ba7d9489.jpg"],
    }
  };
}

export async function getAllWalks() {
  const walks = await getCollection("walks");
  return walks.sort((a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime());
}

/**
 * Walks that get a page of their own on the public site.
 *
 * A walk needs a reviewed write-up as well as photographs. An unreviewed
 * draft is honest about the route and the weather but still carries TODO
 * prompts where Nick's own knowledge goes, and those are not for visitors.
 * Until it is reviewed a walk sits in the archive with its GPX, and returns
 * to the walks list the moment writeupStatus flips to reviewed.
 */
export async function getPublishedWalks() {
  const walks = await getAllWalks();
  return walks.filter(
    (walk) =>
      !walk.data.draft &&
      !walk.data.catalogueOnly &&
      walk.data.writeupStatus === "reviewed",
  );
}

/**
 * Walks recorded but not written up — no photographs, so a page would be a
 * map and four TODO headings. They are listed in the archive with their GPX
 * so the route is still downloadable.
 */
export async function getCatalogueWalks() {
  const walks = await getAllWalks();
  return walks.filter(
    (walk) =>
      !walk.data.draft &&
      (walk.data.catalogueOnly || walk.data.writeupStatus !== "reviewed"),
  );
}

/**
 * Walks ranked for the homepage showcase.
 *
 * Recency is the wrong order for a shop window — it put a 1.5 mile dog amble
 * ahead of three 14-mile hill days. Rank by how much of a day the walk was:
 * distance plus ascent, where 100m of climbing counts about the same as a
 * mile on the flat. `featured: true` pins a walk above the scoring for when
 * the numbers do not capture why a walk is worth showing.
 */
export async function getFeaturedWalks(limit = 3) {
  const walks = await getPublishedWalks();
  const score = (w: { data: { distance: number; ascentM?: number } }) =>
    w.data.distance + (w.data.ascentM ?? 0) / 100;
  return [...walks]
    .sort((a, b) => {
      if (a.data.featured !== b.data.featured) return a.data.featured ? -1 : 1;
      return score(b) - score(a);
    })
    .slice(0, limit);
}

export async function getAllBlogs() {
  const posts = await getCollection("blog");
  return posts.sort((a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime());
}

export async function getPublishedBlogs() {
  const posts = await getAllBlogs();
  return posts.filter((post) => !post.data.draft);
}

export async function getPublishedGallery() {
  const photos = await getCollection("gallery", ({ data }) => !data.draft);
  return photos.sort((a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime());
}

export async function getRegions() {
  const walks = await getPublishedWalks();
  return Array.from(new Set(walks.map((walk) => walk.data.region))).sort((a, b) => a.localeCompare(b));
}


