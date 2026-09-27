/**
 * Admin guard for the functions that write to the GitHub repo.
 *
 * save-content, save-walk and ai-create-post all hold a GITHUB_TOKEN and PUT
 * straight to the contents API on main. None of them checked who was asking:
 * WALK_BUILDER_PASSWORD was declared at the top of each file and referenced
 * nowhere else, so an empty POST reached field validation rather than being
 * rejected. Anyone with the URL could commit anything, including workflow
 * files.
 *
 * Two checks, because either alone is insufficient here:
 *
 *  1. The caller presents a Netlify Identity token that Identity itself
 *     confirms is valid. Verified by asking Identity rather than by decoding
 *     locally, so a forged or expired token cannot pass.
 *  2. That identity is actually an admin. This site has open signup
 *     (disable_signup is false), so "has a valid account" is not an
 *     authorisation decision. The user needs the admin role, or an email on
 *     ADMIN_EMAILS.
 */

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * @returns {Promise<{ok: true, user: object} | {ok: false, status: number, error: string}>}
 */
export async function requireAdmin(req) {
  // Functions here use both signatures: the modern (Request) one and the
  // classic (event) one, whose headers are a plain lower-cased object.
  const header =
    typeof req?.headers?.get === "function"
      ? req.headers.get("authorization") ?? ""
      : req?.headers?.authorization ?? req?.headers?.Authorization ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return { ok: false, status: 401, error: "Sign in required" };
  }

  // Ask Identity to validate the token. The site URL comes from Netlify's own
  // environment so this cannot be pointed somewhere else by the caller.
  const base = process.env.URL ?? process.env.DEPLOY_PRIME_URL;
  if (!base) {
    return { ok: false, status: 503, error: "Identity not configured" };
  }

  let user;
  try {
    const res = await fetch(`${base}/.netlify/identity/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, status: 401, error: "Invalid or expired session" };
    user = await res.json();
  } catch {
    return { ok: false, status: 503, error: "Could not verify session" };
  }

  const roles = user?.app_metadata?.roles ?? [];
  const email = (user?.email ?? "").toLowerCase();
  const isAdmin = roles.includes("admin") || (ADMIN_EMAILS.length > 0 && ADMIN_EMAILS.includes(email));

  if (!isAdmin) {
    // Deliberately the same shape as a sign-in failure: a signed-up stranger
    // should not learn that the account was valid but under-privileged.
    return { ok: false, status: 403, error: "Not authorised" };
  }

  return { ok: true, user };
}

/** Standard JSON response for the modern (Request) signature. */
export function deny({ status, error }) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The same denial for the classic (event) signature. */
export function denyLegacy({ status, error }) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error }),
  };
}
