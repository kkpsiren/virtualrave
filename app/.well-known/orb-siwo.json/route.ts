import { siwoManifest, siwoOriginForHost } from "@/lib/orbSiteManifest";

// Opt-in manifest for browser-site Sign in with Orb (see lib/orbSiteManifest.ts).
// Answered per request host, so it must not be statically cached across hosts.
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const origin = siwoOriginForHost(host);
  if (!origin) {
    return Response.json(
      { message: "Sign in with Orb is not enabled for this origin" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(siwoManifest(origin), {
    headers: { "Cache-Control": "public, max-age=300", Vary: "Host" },
  });
}
