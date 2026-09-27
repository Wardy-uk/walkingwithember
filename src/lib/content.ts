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
 * Walks that get a URL at all.
 *
 * Includes ones whose write-up is not finished: they render a "coming soon"
 * page with the route, the map and the GPX rather than a 404. The walks index
 * links to all of them, so without this those links were dead.
 */
export async function getWalksWithPages() {
  const walks = await getAllWalks();
  return walks.filter((walk) => !walk.data.draft && !walk.data.catalogueOnly);
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



/**
 * Other walks starting near this one.
 *
 * With 59 routes and no cross-linking, a reader who likes one has no way to
 * find its neighbours. Proximity of the start point is the useful measure:
 * walks from the same car park or the next valley are the ones worth
 * offering, and it needs no tags or categories to be kept up to date.
 *
 * Catalogue-only walks are included, since a route with a GPX and no write-up
 * is still worth knowing about if you are already in the area.
 */
export async function getNearbyWalks(
  walk: { slug: string; data: { routeMapLat: number; routeMapLng: number } },
  limit = 4,
  withinKm = 12,
) {
  const all = await getAllWalks();

  const km = (aLat: number, aLng: number, bLat: number, bLng: number) => {
    const R = 6371;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLng = ((bLng - aLng) * Math.PI) / 180;
    const p1 = (aLat * Math.PI) / 180;
    const p2 = (bLat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  return all
    .filter((w) => w.slug !== walk.slug && !w.data.draft)
    .map((w) => ({
      walk: w,
      distanceKm: km(
        walk.data.routeMapLat, walk.data.routeMapLng,
        w.data.routeMapLat, w.data.routeMapLng,
      ),
    }))
    .filter((w) => w.distanceKm <= withinKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}
