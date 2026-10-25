# CallApp

Private group video and audio calling for a team you control.

- **You create the accounts.** Nobody can sign up. The admin adds users, edits their name, username and password, and removes them.
- **Friends only.** People add each other by username and send a friend request. Once accepted, you can chat and call. Non-friends can't see each other, and their online status stays private.
- **Call your friends.** Tap the phone or camera icon next to a friend and they get a ringing screen. Add more friends during a call for a group call (up to 8).
- **Chat and photos.** One-to-one messages that are saved, with photo sharing. A separate chat inside every call.
- **Works everywhere.** Phones (iPhone and Android) and laptops open the web address in the browser. A Windows, Mac and Linux desktop app is also included.
- **Big-screen controls.** Tap any person to enlarge them. In a 1:1 call tap your small picture to swap. Flip between front and back camera, switch the camera on and off, mute, mirror your own preview.

## How it fits together

```
renderer/   the app itself (web page, also used inside the desktop app)
server/     accounts, ringing, signaling, chat, and it serves renderer/ to browsers
main.js     desktop app shell (Electron)
```

Video and audio go directly between people (peer to peer). The server only introduces them, stores accounts and chat, and never sees the call itself.

## 1. Deploy the server (once)

Everything runs from one server. These steps use Render (free) and Neon (free database).

### a) A database so users are never lost
Render's free disk is erased on every restart, so accounts must live in a database.

1. Go to https://neon.tech, sign up, create a project.
2. Copy the **connection string** (starts with `postgresql://`).

### b) Put the project on GitHub
Upload the **whole project folder** (not only `server/`) to one GitHub repository. `node_modules` is not needed.

### c) Create the Render web service
New + > Web Service > pick your repository, then:

| Setting | Value |
|---|---|
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `npm start` |

### d) Environment variables (Render > Environment)

| Name | Value |
|---|---|
| `DATABASE_URL` | the Neon connection string |
| `JWT_SECRET` | any long random text (40+ characters) |
| `ADMIN_USERNAME` | your admin login, for example `admin` |
| `ADMIN_PASSWORD` | your admin password (6+ characters) |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` | optional, see TURN below |

`ADMIN_PASSWORD` is the source of truth for the admin account: if you forget the password, change this variable and redeploy.

### e) Create users
Open your Render address, sign in as admin, tap the **shield** icon, and add users. Use **Edit** on a user to change their name, username, password or admin status, or **Delete** to remove them (tap twice to confirm). Send each person the web address plus their username and password.

## 2. Using it

- **Phone / laptop:** open the web address, sign in. On a phone use "Add to Home Screen" for a full-screen app.
- **Desktop app:** build it (below), install it, and on the sign-in screen enter the same web address once.
- The app must be **open** to receive a call (see Limits).
- Camera and microphone need **https**. Render provides it automatically.

## 3. Build the desktop installers (optional)

```bash
npm install
npm start            # run it in development
npm run dist:win     # .exe, build on Windows
npm run dist:mac     # .dmg, build on a Mac
npm run dist:linux   # .AppImage and .deb
```
Installers appear in `dist/`. If `npm install` fails to download Electron on a restricted network, build on another machine and copy only the installer.

## Messages and calls

- **Edit:** tap your own text message and choose **Edit message**. Allowed for 15 minutes after sending. Photos can't be edited.
- **Delete for everyone:** tap your own message and choose **Delete for everyone** (tap twice to confirm). Allowed any time until the other person sees it, and for 10 minutes after they've seen it.
- **Seen:** your last message shows **Delivered** or **Seen**.
- **Minimize a call** to use the rest of the app while staying on the call. Tap the small window to return.
- **Speaker** turns the other people's sound on or off on your device. Phones can't change between earpiece and speaker from a web page, so use your phone's own speaker control for that.
- **Calling tiles:** when you add someone during a call, a "Calling…" tile appears straight away and turns into their video when they answer.
- **Emoji:** tap the smiley button next to the message box.

## Notifications

Calls and messages notify people in three ways:

| Situation | What happens |
|---|---|
| CallApp open in a browser tab or the desktop app | Ringing screen with sound. If the tab is in the background, a notification also appears. |
| Browser closed, phone or computer on | Web Push. A notification appears with the caller or sender, and tapping it opens the app at that chat or call. Works on Android Chrome, desktop Chrome/Edge/Firefox and iPhone (see below). |
| Desktop app closed | Not possible. The desktop app can only notify while it is running. |

Each person turns this on once: the banner in the sidebar asks, and the browser asks for permission. Each device has its own subscription, so turning it on on a phone doesn't affect a laptop.

**iPhone:** Apple only sends notifications to web apps added to the Home Screen. Open the address in Safari, tap Share, choose **Add to Home Screen**, open CallApp from that icon, then tap **Turn on**. iOS 16.4 or newer is required.

**Keys:** the notification keys are created the first time the server starts and stored in the database, so nothing needs configuring. To use your own, set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (for example `mailto:you@example.com`).

## TURN server (for hard networks)

Most calls connect directly. Some office, hotel and mobile networks block that and need a relay (TURN). Get credentials from a provider (Metered, Twilio, Xirsys) or run coturn, then set `TURN_URL` (for example `turn:your.host:3478`), `TURN_USERNAME`, `TURN_CREDENTIAL` on Render. Clients pick this up automatically, no rebuild needed.

## Limits worth knowing

- **Closed desktop app gets no notifications.** Phones and browsers with notifications turned on do get them when closed (see Notifications).
- **Calls ring for 45 seconds** and then count as missed, both on screen and as a notification.
- **Group size:** calls are peer to peer, so every person sends video to every other person. It works well up to about 4 to 6 people and is capped at 8. Bigger meetings need a media server.
- **Free Render sleeps** after idle time, so the first load can take up to a minute.
- Photos are resized to about 1280 pixels before sending to keep chat fast.

## Security notes

Passwords are stored hashed (bcrypt). Sign-in is rate limited. Changing a password signs that person out everywhere. Users deleted by the admin are disconnected immediately. Keep `JWT_SECRET` and `ADMIN_PASSWORD` private.
