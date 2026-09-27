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
      /**
       * The route's own distance in miles, when it differs from what was
       * walked. A retrace for dropped kit, a wrong turn or a there-and-back
       * to a summit all inflate the GPS figure above what someone following
       * the route would cover.
       */
      routeDistance: z.number().positive().optional(),
      /** Total ascent in metres, from the recorded GPS track. */
      ascentM: z.number().optional(),
      /** Pin to the homepage regardless of how it scores. */
      featured: z.boolean().default(false),
      /** Who else was on the walk. Confirmed by Nick, never inferred. */
      companions: z.array(z.string()).default([]),
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
      parking: z.string().optional(),
      /** OS grid reference of the GPX start point, i.e. where the car goes. */
      startGridRef: z.string().optional(),
      /** Postcode nearest the start, for a sat nav. */
      startPostcode: z.string().optional(),
      /** Stiles on the route. "none" is a selling point on a dog walk. */
      stiles: z.enum(["none", "few", "several", "many"]).optional(),
      /** Open Access land: triggers the 1 Mar to 31 Jul lead requirement. */
      accessLand: z.boolean().optional(),
      livestock: z.enum(["none", "likely", "certain"]).optional(),
      water: z.enum(["none", "some", "plenty"]).optional(),
      roads: z.enum(["none", "short", "significant"]).optional(),
      terrain: z.enum(["easy", "rough", "scrambly"]).optional(),
      offLead: z.enum(["no", "partly", "mostly"]).optional(),
      /**
       * Free-form dog facts, for anything the preset fields above do not
       * cover. Rendered as icons alongside them, in order.
       */
      dogNotes: z
        .array(
          z.object({
            icon: z
              .enum(["stiles", "water", "livestock", "access", "offlead", "roads", "terrain", "note"])
              .default("note"),
            label: z.string(),
            detail: z.string().optional(),
            tone: z.enum(["good", "warn", "note"]).default("note"),
          }),
        )
        .default([]),
      /** Nearest pub or cafe worth knowing about. */
      refreshments: z.string().optional(),
      /** Public toilets on or near the route. */
      toilets: z.string().optional(),
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
    // Kept under 160 so Google shows the whole thing rather than cutting it
    // mid sentence, which is what a 200 character limit was allowing.
    seoDescription: z.string().max(160),
    heroImage: z.string().optional(),
    heroAlt: z.string().optional(),
    /**
     * Introductions with a photo each, used on the About page. Kept in
     * frontmatter rather than hard-coded in the template so the copy and the
     * picture stay together, and so the CMS can reach them.
     */
    people: z
      .array(
        z.object({
          heading: z.string(),
          image: z.string(),
          alt: z.string(),
          body: z.string(),
        }),
      )
      .optional(),
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
