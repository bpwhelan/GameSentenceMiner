# Remote Play

Remote Play is an experimental Windows-first browser view at `http://localhost:7275/remote-play`.
It sends the OBS program output to one browser over WebRTC and can optionally forward browser
keyboard and pointer input to GSM's configured game window.

## Requirements

- OBS Studio must be running with its WebSocket server configured for GSM.
- The OBS program canvas must contain the game source you want to stream.
- Game audio uses GSM's Windows process-loopback helper and the game window selected in OBS.
  Packaged builds include the helper; development checkouts can build it with
  `npm run build:windows-helpers`. Windows must support process-loopback capture.
- The browser and GSM computer can connect directly over a local network or a NAT path supported
  by the configured public STUN servers. Restrictive or symmetric NATs may still require TURN.
- Windows is required for remote input. Video and OCR lookup remain available when input is not.

## Connect

1. Open `http://<gsm-computer>:7275/remote-play` on your phone or other device.
2. Select **Connect to stream**. No session code or visit to the GSM computer is required.
3. Remote input starts automatically when the stream connects. Click OCR text to look it up without sending that click to the game.

You can bookmark this address on your phone for later sessions.

Only one browser can be connected at a time. Pressing Escape, changing tabs,
losing browser focus, disconnecting, or closing the page releases held keys and pointer buttons.
GSM also refuses to enable input unless the WebRTC peer is connected and the configured game
window can be brought to the foreground.

## Media Lifecycle

A session starts OBS Virtual Camera only when it is not already active. The browser receives its
video through `aiortc` and DirectShow. On disconnect, GSM closes the peer and media track; it stops
Virtual Camera only if that session started it.

The camera is opened at OBS's output resolution and 30 fps. Video uses VP8 with **High**
selected by default (up to 8 Mbps). **Balanced** allows up to 4 Mbps and **Ultra** up to
16 Mbps; disconnect before changing the preset. Network congestion can reduce the actual
bitrate. The controls show received resolution, frame rate, and bitrate, which can also be
lower during static scenes. Slow encoding drops old capture frames instead of accumulating
playback delay. Encoding still uses the CPU.

Replay-buffer recording quality settings do not control WebRTC: this is a separate live encode,
so even Ultra is not a guarantee of recording-quality output. Higher presets need more bandwidth
and CPU capacity. OBS output scaling also affects the available picture detail.

Audio captures only the selected game's process tree at 48 kHz stereo and sends it using Opus.
It does not capture the microphone, unrelated desktop sounds, or OBS's mixed/filtered audio.
If capture cannot start, video remains available and the audio status explains the problem.
Changing the selected game process stops audio; reconnect to capture the new game. A missing
or unsupported helper is reported instead of silently presenting a supposedly working audio stream.
If the browser blocks audible autoplay, video starts muted and **Enable sound** unlocks playback.
**Mute** controls local playback without stopping capture. Disconnect releases the audio helper.

For a manual check, play a game with sound, connect from a second device, select **Enable sound**
if shown, and inspect the received resolution/bitrate during movement. Compare High and Ultra
after reconnecting. Check mute, disconnect/reconnect, and switching the selected game. Automated
tests cover stereo PCM timing, bounded queues, encoder bitrate adaptation, real local WebRTC
audio/video negotiation, and browser playback controls; an actual remote game session is still
needed to judge perceived quality, latency, and audio/video sync on your network.

Both peers use Cloudflare STUN with Google STUN as a fallback to discover server-reflexive ICE
candidates. This iteration does not relay media through TURN, so connectivity is not guaranteed
across every firewall or NAT configuration.

## OCR Lookup

Remote Play reuses the normalized `word_coordinates` and `overlay_clear` events produced by GSM's
OCR overlay pipeline. Clicking a region sends its text through GSM's proxy to the
local Yomitan `/tokenize` service and displays the returned surface forms and readings.

This is not yet Yomitan's full extension popup. Dictionary definitions, frequency data, styling,
and extension actions depend on Yomitan's extension runtime and popup renderer. A later iteration
can either host that renderer in a supported extension context or define a dedicated lookup API
that returns the complete dictionary result model.

## Security Boundary

- There is no pairing or authentication: any device that can reach GSM can connect and enable input.
- HTTP and WebSocket origins must match the public Host header preserved by GSM's gateway.
- A second browser is rejected while a remote session is active.
- Remote input starts automatically on supported connected sessions; OCR lookup stays available and consumes lookup clicks without forwarding them to the game.

Do not expose port 7275 directly to the public internet. A future internet-facing version requires
TLS, a TURN deployment, stronger pairing/revocation, rate limits, and an explicit network exposure
configuration.
