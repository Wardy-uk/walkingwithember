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


