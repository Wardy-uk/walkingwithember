import type { Config, Context } from "@netlify/edge-functions";

const COOKIE = "wwe_ab_home";
const VARIANTS = ["a", "b"] as const;
type Variant = (typeof VARIANTS)[number];

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days — a returning visitor keeps their variant

/**
 * Share of new visitors sent to variant B, 0 to 1.
 *
 * Live at 50/50. Variant B was parked at 0 while every walk was a draft,
 * because it draws its ethos images from *published* walks and rendered two
 * empty grey boxes; publishing the sixteen walks fixed that.
 *
 * ?ab=a / ?ab=b forces either arm regardless of the split.
 */
const B_SHARE = 0.5;

function isVariant(value: string | undefined): value is Variant {
  return value === "a" || value === "b";
}

export default async function handler(request: Request, context: Context) {
  const url = new URL(request.url);

  // ?ab=a / ?ab=b forces a variant and pins it, so you can eyeball either
  // one on the live site without waiting for the coin flip to go your way.
  const forced = url.searchParams.get("ab") ?? undefined;
  const existing = context.cookies.get(COOKIE);

  let variant: Variant;
  let shouldSetCookie: boolean;

  if (isVariant(forced)) {
    variant = forced;
    shouldSetCookie = true;
  } else if (isVariant(existing)) {
    variant = existing;
    shouldSetCookie = false;
  } else {
    variant = Math.random() < B_SHARE ? "b" : "a";
    shouldSetCookie = true;
  }

  // Variant A is the real "/" page; only B needs a rewrite.
  const response =
    variant === "b"
      ? await context.rewrite(new URL("/home-b/", url))
      : await context.next();

  const out = new Response(response.body, response);

  if (shouldSetCookie) {
    out.headers.append(
      "set-cookie",
      `${COOKIE}=${variant}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax; Secure`,
    );
  }

  // Expose the assignment to the page so analytics can label the session,
  // and stop any shared cache from serving one variant to everybody.
  out.headers.set("x-ab-home", variant);
  out.headers.set("cache-control", "public, max-age=0, must-revalidate");
  out.headers.set("netlify-cdn-cache-control", "no-store");

  return out;
}

export const config: Config = {
  path: "/",
  cache: "manual",
};
