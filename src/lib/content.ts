import { getCollection } from "astro:content";

export async function getSiteSettings() {
  const settings = await getCollection("settings");
  return settings[0]?.data ?? {
    siteName: "Walking with Ember",
    tagline: "UK hiking routes, trail notes, and honest hill days out",
    baseUrl: "https://example.com",
    social: {},
    homepage: {
      mastheadImage: "/images/uploads/ember-walking.jpg",
      galleryImages: ["/images/uploads/ember-walking.jpg"],
    }
  };
}

export async function getPublishedWalks() {
  const walks = await getCollection("walks", ({ data }) => !data.draft);
  return walks.sort((a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime());
}

export async function getPublishedBlogs() {
  const posts = await getCollection("blog", ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime());
}

export async function getPublishedGallery() {
  const photos = await getCollection("gallery", ({ data }) => !data.draft);
  return photos.sort((a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime());
}

export async function getRegions() {
  const walks = await getPublishedWalks();
  return Array.from(new Set(walks.map((walk) => walk.data.region))).sort((a, b) => a.localeCompare(b));
}
