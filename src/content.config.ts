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
      /** Total ascent in metres, from the recorded GPS track. */
      ascentM: z.number().optional(),
      /** Pin to the homepage regardless of how it scores. */
      featured: z.boolean().default(false),
      /** "draft" until Nick has been through the proposed write-up. */
      writeupStatus: z.enum(["draft", "reviewed"]).optional(),
      /**
       * Listed in the walks archive with its GPX, but gets no page of its own.
       * Used for walks with no photographs, where a full page would be a map
       * and four TODO headings.
       */
      catalogueOnly: z.boolean().default(false),
      location: z.string(),
      region: z.string(),
      dogFriendly: z.boolean(),
      parking: z.string(),
      walkDate: z.coerce.date().optional(),
      gpxDownload: z.string().optional(),
      stravaRecord: z.string().url().optional(),
      stravaFlyby: z.string().url().optional(),
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

const gallery = defineCollection({
  type: "content",
  schema: () =>
    z.object({
      title: z.string(),
      image: z.string(),
      caption: z.string().max(260).optional(),
      location: z.string().optional(),
      publishDate: z.coerce.date(),
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
      homepage: z.object({
        mastheadImage: z.string(),
        galleryImages: z.array(z.string()).default([]),
      }),
    }),
});

export const collections = {
  walks,
  blog,
  gallery,
  pages,
  settings,
};
