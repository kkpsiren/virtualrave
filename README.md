# Virtual Rave

This repository is a Next.js site.
The npm package name is `virtual-rave-claim`.
It is kkpsiren's fork of virtualravearena/virtualrave.
A visitor collects VR 303 editions on Lens.
Each edition costs 1 GHO.
The supply is 303 editions.
Collection runs on Lens chain 232.
The contract is `0x303AC1D2736C70A9BaE4FC46aAe1c6Ed41C629Af`.

## What you can do

You can connect an injected wallet and collect an edition.
WalletConnect loads only when `NEXT_PUBLIC_WC_PROJECT_ID` is set.
You can sign in with Orb and collect to a Lens profile.
You can view claimed editions on the collectors wall.
You can read the CC0 notes for the artwork.
You can build a 16-step acid pattern in the studio.
You can export that pattern as MIDI or WAV.
You can play the mixtape in the page.
You can read the drops list and the events text.

The home page is `app/page.tsx`.
The other routes are API routes and the sign-in manifest.

## Sign-in

Sign-in runs in the browser.
The client is `lib/orbSiteSignIn.ts`.
The page posts `{state, codeChallenge}` to `https://orbapi.xyz/init-site-sign-in`.
The page then polls `https://orbapi.xyz/poll-site-sign-in`.
A ready response shows a QR code and an `orbapp://` link.
Touch screens also get an "open orb app" link.
The site opts in at `/.well-known/orb-siwo.json`.
The default origins are `https://www.virtualrave.xyz` and `https://virtualrave.xyz`.
`ORB_SIWO_ORIGINS` replaces that list.
Any other host gets HTTP 404.
The protocol returns no refresh token.
The access token lasts about 10 minutes.
The session stays in memory and ends at expiry.

`package.json` still depends on `@orbclub/modules`.
That package does not start sign-in.
`lib/orbSession.ts` uses it to read token expiry and the Lens account.
`lib/useLensSession.ts` uses it to test token expiry.
The Lens session then resumes from the Orb tokens.

On 23 September 2026, commit `18fc6aa` moved sign-in to this protocol.
That commit removed `lib/orbLogin.ts` and `createOrbLogin`.
It also removed the `/api/orb/init-sign-in` and `/api/orb/poll-sign-in` proxies.
Commit `c1ea04e` merged that change into `main`.

## Where the code lives

`app/api/collectors/` reads and refreshes the collector snapshot.
`app/api/lens/account-authority/route.ts` reads Lens account authority.
`app/api/orb/buy/route.ts` forwards a profile buy to Orb.
`components/` holds the page sections, wallet modal, and Orb login.
`components/mint/MintCeremonyScene.tsx` draws the mint scene with three.js.
`lib/` holds sign-in, Lens, mint, synth, and collector logic.
`scripts/build-artwork-map.mjs` writes artwork URLs into `lib/vr303Artwork.ts`.
`scripts/upload-grove-audio.mjs` uploads mixtape audio and writes a Grove manifest.
`data/` holds collector and trait JSON.
`public/` holds images, MIDI files, and mixtape manifests.

## Commands

`package.json` defines these scripts:

- `dev` runs `next dev`.
- `build` runs `next build`.
- `start` runs `next start`.
- `upload:grove` runs `node scripts/upload-grove-audio.mjs`.
- `build:artwork-map` runs `node scripts/build-artwork-map.mjs`.

`.gitignore` ignores `*.md`.
Track a new Markdown file with `git add -f`.
