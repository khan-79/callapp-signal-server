# CallApp — Cross-Platform Group Video/Audio Calling

A desktop app (Windows, Mac, Linux) **and** a mobile-friendly web page for group
video/audio calls over the internet, built with WebRTC. Peers connect directly to
each other (mesh); a small signaling server just introduces peers to each other and
relays chat messages — it never sees your audio/video.

**Desktop:** install the built .exe/.dmg/.AppImage.
**iPhone / Android:** no install needed — just open the signaling server's URL in
Safari or Chrome (see "Use it on mobile" below). It's the exact same calling code,
just running as a web page instead of inside Electron.

**Note on where this was built:** I don't have internet access in this sandbox,
so I couldn't run `npm install` or actually produce the .exe/.dmg/.deb files for
you here. Everything below is complete, ready-to-run source code — you'll run
two commands on your own machine (which does have internet) to install
dependencies and build the installers.

## What you're getting

```
callapp/
├── main.js            Electron main process
├── preload.js          Preload script
├── package.json        App + electron-builder config (installer settings)
├── renderer/            The UI (join screen, video grid, controls, chat)
│   ├── index.html
│   ├── style.css
│   └── renderer.js
└── server/              Signaling server (deploy this separately, once)
    ├── server.js
    └── package.json
```

Good for small-to-medium groups (roughly up to 6-8 people per call) since it
uses a mesh topology — every participant connects directly to every other
participant. Beyond that, you'd want a media server (SFU) instead — happy to
build that version if you need bigger calls.

## 1. Deploy the signaling server (do this once)

The signaling server does two jobs now: it relays "hey, connect to this person"
messages between peers, **and** it serves the call page itself so phones/laptops
can open it directly in a browser. Any of these work: Render, Railway, Fly.io, a
$5 DigitalOcean droplet, or your own machine with a port forwarded.

To run it locally:

```bash
cd server
npm install
npm start
```

It listens on port 3000 by default (or `$PORT`). Once deployed, note its public
URL, e.g. `https://callapp-signal.onrender.com` — you'll paste this into the
Electron app when joining a room, and it's also the link you open directly in a
mobile browser (see below).

**Important:** the server reads the `renderer/` folder (one level up from
`server/`) to serve the call page, so when you deploy, push the **whole project**
to your Git repo — not just the `server` folder's two files — and set Render's
"Root Directory" setting to `server` (that just tells Render where to run `npm
install`/`npm start` from; the `renderer` folder still needs to be present
alongside it in the same repo).

## 2. Run the app in development

```bash
cd callapp        # the root folder, not server/
npm install
npm start
```

This opens the app. Enter your name, a room code (anything — share the same
code with others to land in the same call), and the signaling server URL from
step 1. First person to use a room code creates it; everyone else joins it.

## Use it on mobile (iPhone & Android) — no install needed

Once the signaling server is deployed (step 1), just open its URL in a mobile
browser — e.g. `https://callapp-signal.onrender.com` in Safari (iPhone) or Chrome
(Android). The exact same join screen, video grid, mute/camera controls, and chat
show up as a normal web page, and a desktop app user and a phone user can be in
the same room together.

A couple of mobile-specific notes:
- The page requires **HTTPS** to access the camera/microphone (this is a browser
  security rule, not something this app controls) — Render and similar hosts give
  you HTTPS automatically, so this just works once deployed.
- The browser will ask for camera/mic permission the first time — allow it.
- For the best experience, add the page to your home screen (Safari: Share →
  "Add to Home Screen"; Chrome: menu → "Add to Home screen") so it opens full-screen
  like a regular app.

## 3. Build installers for Windows / Mac / Linux

Still from the `callapp` root folder:

```bash
npm run dist:win      # produces an .exe installer (NSIS) — build this ON Windows, or via CI
npm run dist:mac      # produces a .dmg — build this ON a Mac (Apple requires this)
npm run dist:linux    # produces an .AppImage and .deb
```

Or `npm run dist` to attempt all three at once (only reliable when run on CI,
e.g. GitHub Actions with a matrix of windows-latest/macos-latest/ubuntu-latest
runners — cross-compiling Mac installers from Windows/Linux isn't supported by
Apple's tooling).

The finished installers land in `callapp/dist/`. Double-click to install, same
as any commercial app.

## TURN server (important for reliability)

WebRTC needs STUN to work through most home routers, but some networks
(corporate firewalls, some mobile carriers, hotel wifi) block direct
peer-to-peer connections entirely. For those cases you need a TURN server,
which relays the actual media.

The app ships with only free public STUN servers, so calls will work most of
the time but may occasionally fail to connect between two "difficult" networks.
To fix that:

1. Run your own TURN server (the `coturn` project is the standard open-source
   option), or use a hosted TURN provider (Twilio Network Traversal Service,
   Metered.ca, Xirsys all offer free/cheap tiers).
2. Open `renderer/renderer.js` and add your TURN credentials to the
   `ICE_SERVERS` array near the top of the file (there's a commented-out
   example line already there).

## Notes

- Camera/mic permissions are requested the first time each user joins a call.
- Mute/camera-off, room-code copy, and a lightweight text chat are included.
- No accounts or database — rooms exist only as long as people are in them.
