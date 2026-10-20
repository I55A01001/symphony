# Symphony Jam relay

A small, dependency-free Node server for shared queues and host-led synchronized
playback. Audio goes directly from each listener's music source to their app;
this server carries only track metadata, participant names, and playback state.

## Deploy for internet listening

Deploy this directory on a host that runs persistent Node processes or Docker.
Use Node 20 or later, start command `npm start`, and health check `/health`.
The server binds to `0.0.0.0` and uses the hosting provider's `PORT`, default 8787.
Alternatively build the included Dockerfile and expose container port 8787.
Put it behind your host's HTTPS endpoint. No database, package installation,
API key, or account service is required.

Your proxy must support long-lived server-sent event connections. Disable
response buffering on `/rooms/*/events` and set an idle timeout above 30 seconds.
For nginx, use `proxy_buffering off;` and `proxy_read_timeout 60s;`.
The client also polls every two seconds to recover when streaming connections
are interrupted. Queue requests remain pending until the host acknowledges
them, and the client deduplicates recovered additions.
Run exactly **one replica**: room state is in memory. A server restart ends all
rooms. Do not deploy to a platform limited to short-lived request functions.

## Use it in Symphony

1. Open **Jam** using the radio icon in the sidebar.
2. Enter your display name and the server's HTTPS address; choose **Start a Jam**.
3. Select **Copy invite** and send the complete code to a friend.
4. Your friend opens **Jam → Join a Jam** in this same Symphony build, enters a
   name, and pastes the invite.
5. Add songs from the Jam search or a song's **Add to Jam** menu. The host controls
   play, pause, seeking, skips, and queue order. Listener volume stays local.

The server address is remembered locally. To preconfigure a build, set
`VITE_JAM_SERVER_URL=https://your-server.example` before building the app.
Invites are pasteable codes, not public web player pages.

## Local verification

Run `node server.mjs`, then use `http://localhost:8787` in Symphony. This is for
testing on one machine. Internet use requires a public HTTPS deployment.
Run `node --test server.test.mjs` for the two-client relay integration test.

## Session behavior and limits

- Up to 20 participants and 200 queued tracks per room.
- Names are shown to other room members; no login is required.
- Invites contain a random join secret. Anyone with the invite can join.
- Each participant gets a separate random session token. Only the host can
  publish playback state, remove participants, or end the room for everyone.
- Removed participant tokens stop working; a person holding the invite may
  join again. End the room and create a new one to replace the invitation.
- A lost host has 30 seconds to reconnect. Disconnected guests expire after
  60 seconds. Inactive rooms expire after 30 minutes.
- Request size, basic per-address rate limits, and room limits are enforced.
  For a larger deployment, add ingress-level rate limits and monitoring.
- Playback position is corrected when drift exceeds about 1.2 seconds. This
  is approximate shared listening, not sample-accurate multiroom audio.
- Each device needs access to the chosen song. Regional/source failures can
  prevent a listener from playing a song even when others can hear it.
- Keep HTTPS access logs private: event-stream URLs contain session tokens.
