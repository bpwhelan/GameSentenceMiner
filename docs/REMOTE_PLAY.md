# Remote Play

Remote Play is an experimental Windows-first browser view at `http://localhost:7275/remote-play`.
It sends the OBS program output to one browser over WebRTC and can optionally forward browser
keyboard and pointer input to GSM's configured game window.

## Requirements

- OBS Studio must be running with its WebSocket server configured for GSM.
- The OBS program canvas must contain the game source you want to stream.
- The browser and GSM computer can connect directly over a local network or a NAT path supported
  by the configured public STUN servers. Restrictive or symmetric NATs may still require TURN.
- Windows is required for remote input. Video and OCR lookup remain available when input is not.

## Connect

1. On the GSM computer, open `/remote-play` and select **Copy session code**. This creates a random
   code that expires after 15 minutes without occupying the remote client slot.
2. Open `http://<gsm-computer>:7275/remote-play` on the other device.
3. Select **Enter a session code**, enter the copied code, and connect.
4. Enable input only when the intended game window is visible and ready to receive it.

Only one authenticated browser can be connected at a time. Pressing Escape, changing tabs,
losing browser focus, disconnecting, or closing the page releases held keys and pointer buttons.
GSM also refuses to enable input unless the WebRTC peer is connected and the configured game
window can be brought to the foreground.

## Media Lifecycle

A session starts OBS Virtual Camera only when it is not already active. The browser receives its
video through `aiortc` and DirectShow. On disconnect, GSM closes the peer and media track; it stops
Virtual Camera only if that session started it.

Audio is not included in this iteration.

Both peers use Cloudflare STUN with Google STUN as a fallback to discover server-reflexive ICE
candidates. This iteration does not relay media through TURN, so connectivity is not guaranteed
across every firewall or NAT configuration.

## OCR Lookup

Remote Play reuses the normalized `word_coordinates` and `overlay_clear` events produced by GSM's
OCR overlay pipeline. Clicking a region sends its text through GSM's authenticated proxy to the
local Yomitan `/tokenize` service and displays the returned surface forms and readings.

This is not yet Yomitan's full extension popup. Dictionary definitions, frequency data, styling,
and extension actions depend on Yomitan's extension runtime and popup renderer. A later iteration
can either host that renderer in a supported extension context or define a dedicated lookup API
that returns the complete dictionary result model.

## Security Boundary

- Session codes are generated only for loopback HTTP clients and are never placed in URLs.
- WebSocket authentication must be the first client message.
- HTTP lookup requests use the code in a request header.
- HTTP and WebSocket origins must match the public Host header preserved by GSM's gateway.
- A second browser is rejected while a remote session is active.
- Remote input defaults to off and is gated independently from video and OCR lookup.

Do not expose port 7275 directly to the public internet. A future internet-facing version requires
TLS, a TURN deployment, stronger pairing/revocation, rate limits, and an explicit network exposure
configuration.
