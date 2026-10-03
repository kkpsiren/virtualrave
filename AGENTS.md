# Agent notes

## Purpose

This is the Virtual Rave Next.js site (`virtual-rave-claim`).
Visitors collect VR 303 on Lens, use the studio, and play the mixtape.
Keep Orb sign-in in the browser.

## Directory map

- `app/page.tsx` — home page.
- `app/.well-known/orb-siwo.json/route.ts` — sign-in opt-in manifest.
- `app/api/collectors/` — collector snapshot and chain refresh.
- `app/api/lens/account-authority/route.ts` — Lens account authority.
- `app/api/orb/buy/route.ts` — forwards a buy to Orb.
- `components/` — page sections, wallet modal, Orb login, mint scene.
- `lib/orbSiteSignIn.ts` — browser sign-in client.
- `lib/orbSiteManifest.ts` — allowed sign-in origins.
- `lib/orbSession.ts` — in-memory Orb session.
- `lib/useLensSession.ts` — resumes a Lens session from Orb tokens.
- `lib/synth303.ts` — studio synth.
- `lib/collectors.ts` — collector file and chain reads.
- `scripts/` — artwork map and Grove audio upload.
- `data/` — collector and trait JSON.
- `public/` — images, MIDI, and mixtape manifests.

## Sign-in constraint

Call `signInWithOrb` in `lib/orbSiteSignIn.ts`.
Keep the posts in the page. The Orb API limits them per client IP.
Leave `@orbclub/modules` for token expiry and Lens account reads.
Do not restore `createOrbLogin` or the old init and poll proxies.
The default manifest allows `https://www.virtualrave.xyz` and `https://virtualrave.xyz`.
`ORB_SIWO_ORIGINS` replaces that list. Other origins get HTTP 404.
The protocol issues no refresh token. Keep the session in memory.
Clear the session when the access token expires (about 10 minutes).

## Commands

Scripts in `package.json`:

- `dev` — `next dev`
- `build` — `next build`
- `start` — `next start`
- `upload:grove` — `node scripts/upload-grove-audio.mjs`
- `build:artwork-map` — `node scripts/build-artwork-map.mjs`

`.gitignore` ignores `*.md`. Track a new Markdown file with `git add -f`.
