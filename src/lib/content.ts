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

export async function getPublishedWalks() {
  const walks = await getAllWalks();
  return walks.filter((walk) => !walk.data.draft);
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


