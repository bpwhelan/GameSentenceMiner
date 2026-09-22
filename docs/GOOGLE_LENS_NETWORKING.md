# Google Lens networking

Google Lens keeps a pool of reusable HTTP sessions. Each request exclusively
borrows a session, allowing concurrent OCR workers and newly created manual-scan
threads to reuse connections safely. Disabling the engine closes idle sessions;
requests already running finish before their sessions close. Cookies are not
retained between scans.

The request uses the configured OCR language. Its region comes from the system
locale, and its timezone is the system's IANA timezone name. Unavailable metadata
is omitted. A locale is a user preference, not a physical-location measurement;
these fields do not guarantee which Google server handles the request.

Image uploads remain lossless PNG with the existing three-megapixel limit. The
endpoint, Chrome impersonation, and 20-second request timeout are unchanged.
GSM does not add automatic retries to Lens requests.

## Diagnosing latency

Enable **Advanced Debug Logging** in the OCR settings. The existing
`ocr_logs/ocr_debug_*.jsonl` file will include `google_lens.request` events:

| Field | Meaning |
| --- | --- |
| `encode_ms` | Time spent resizing and encoding the image. |
| `image_bytes`, `payload_bytes` | Encoded image and complete protobuf upload sizes, in bytes. |
| `dns_finished_ms`, `connect_finished_ms`, `tls_finished_ms` | Cumulative milestones from curl's transfer start, in milliseconds. |
| `upload_finished_ms` | Time from transfer start until curl finished sending the request. |
| `first_byte_ms`, `transfer_total_ms` | Time to the first response byte and the complete transfer. |
| `request_ms` | Wall time around session acquisition and the HTTP request. |
| `new_connections` | New connections made for this transfer. Zero on a successful request normally indicates reuse. |
| `server_ip`, `http_version`, `status_code` | Remote peer, curl's HTTP-version enum value, and HTTP status. |
| `error_type`, `curl_error_code` | Transport failure category and curl error code, when available. |

Milestones overlap and should not be added together. Reused connections normally
have zero connection/TLS setup times. Time to first byte includes upload and
server work; it is not a pure measurement of server processing. Proxying and
redirects can also affect interpretation. Failed requests include whatever
timings curl collected before the failure.

Compare first and subsequent requests on affected networks, using comparable
image sizes. The events contain byte counts and transport metadata, not image
data, OCR text, API keys, response bodies, or proxy credentials. Normal logs also
report HTTP status or the transport error category when a request fails.

## Shareable latency test

After installing a GSM build containing the latency command, users with a
standard Windows installation can paste this into PowerShell:

```powershell
& "$env:APPDATA\GameSentenceMiner\python_venv\Scripts\python.exe" -I -m GameSentenceMiner.ocr.lens_latency
```

For a custom data folder, replace the path before `python_venv` with the folder
shown in **Settings > Data Folder**. From a source checkout, use
`.venv\Scripts\python.exe -m GameSentenceMiner.ocr.lens_latency`.

The command uploads a generated text image six times, using the installed Lens
engine and the user's OCR language. It reports total scan time, HTTP request
time, cumulative TLS and first-byte timings, connection reuse, HTTP status,
and whether OCR recognized the expected text. It prints the first request's
latency and the median of the subsequent requests. Add `--runs 10` for more
samples; it stops on a failed request. It does not change the user's settings.

Ask users to share the output, their country, and whether a VPN or proxy was
active. Compare the same build across locations. This small image primarily
tests request latency; larger game screenshots may take longer to upload.
For those, use the normal OCR diagnostic events described above.
