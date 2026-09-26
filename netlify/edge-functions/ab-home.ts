import type { Config, Context } from "@netlify/edge-functions";

const COOKIE = "wwe_ab_home";
const VARIANTS = ["a", "b"] as const;
type Variant = (typeof VARIANTS)[number];

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days — a returning visitor keeps their variant

/**
 * Share of new visitors sent to variant B, 0 to 1.
 *
 * Parked at 0 because variant B draws its ethos images from *published*
 * walks, and every walk is still a draft — so that section renders as two
 * empty grey boxes. Set this to 0.5 once a couple of walks are live and the
 * test becomes meaningful. ?ab=b still forces variant B for eyeballing it.
 */
const B_SHARE = 0;

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
