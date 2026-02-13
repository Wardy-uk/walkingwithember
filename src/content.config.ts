import { defineCollection, z } from "astro:content";

const walks = defineCollection({
  type: "content",
  schema: () =>
    z.object({
      title: z.string(),
      summary: z.string().max(240),
      heroImage: z.string(),
      publishDate: z.coerce.date(),
      difficulty: z.enum(["Easy", "Moderate", "Hard"]),
      distance: z.number().positive(),
      location: z.string(),
      region: z.string(),
      dogFriendly: z.boolean(),
      parking: z.string(),
      gpxDownload: z.string().url(),
      stravaRecord: z.string().url(),
      stravaFlyby: z.string().url(),
      tags: z.array(z.string()).default([]),
      osMapsLink: z.string().url().optional(),
      routeMapLat: z.number(),
      routeMapLng: z.number(),
      routeMapZoom: z.number().default(12),
      draft: z.boolean().default(false),
    }),
});

const blog = defineCollection({
  type: "content",
  schema: () =>
    z.object({
      title: z.string(),
      excerpt: z.string().max(260),
      coverImage: z.string(),
      author: z.string(),
      publishDate: z.coerce.date(),
      tags: z.array(z.string()).default([]),
      relatedWalks: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
    }),
});

const pages = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    seoDescription: z.string().max(200),
  }),
});

const settings = defineCollection({
  type: "data",
  schema: z.object({
      siteName: z.string(),
      tagline: z.string(),
      baseUrl: z.string().url(),
      social: z.object({
        instagram: z.union([z.string().url(), z.literal("")]).optional(),
        facebook: z.union([z.string().url(), z.literal("")]).optional(),
      }),
    }),
});

export const collections = {
  walks,
  blog,
  pages,
  settings,
};
