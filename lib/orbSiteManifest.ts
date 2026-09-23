/**
 * Server-only. Opts this site into browser-site Sign in with Orb.
 *
 * Before issuing a sign-in for an origin, the Orb backend fetches
 * `<origin>/.well-known/orb-siwo.json` and requires HTTP 200,
 * `application/json`, under 2KB, with exactly `{"version":1,"origin":"<origin>"}`
 * where `origin` equals the requesting page's Origin (scheme + host, no slash).
 *
 * Production is https://www.virtualrave.xyz (the apex https://virtualrave.xyz
 * redirects there). The manifest names the origin of the host being asked,
 * but only for hosts on this allow-list, so preview deployments (which are on
 * other origins and cannot sign in) answer 404. Set `ORB_SIWO_ORIGINS`
 * (comma-separated https origins) to replace the list, e.g. for a new domain.
 */

export const DEFAULT_SIWO_ORIGINS = ["https://www.virtualrave.xyz", "https://virtualrave.xyz"];

export function allowedSiwoOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const configured = env.ORB_SIWO_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean);
  const list = configured?.length ? configured : DEFAULT_SIWO_ORIGINS;
  return list.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.origin === value;
    } catch {
      return false;
    }
  });
}

/** The origin to name in the manifest for a request to `host`, or null when that host is not opted in. */
export function siwoOriginForHost(
  host: string | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!host) return null;
  const candidate = `https://${host.trim().toLowerCase()}`;
  return allowedSiwoOrigins(env).find((origin) => origin === candidate) ?? null;
}

/** The manifest body. Exact keys only. */
export function siwoManifest(origin: string) {
  return { version: 1 as const, origin };
}
