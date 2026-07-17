# Agent Prompt: Implement Tadoku Username/Password Session Authentication

Use this prompt with an engineering agent that needs to replace manually copied Tadoku session cookies or tokens with automatic username/password authentication.

---

You are updating a Tadoku integration so users provide their Tadoku username (or email) and password instead of manually copying a session cookie or refreshing a token every month.

## Goal

Implement credential-based Tadoku authentication that:

1. Saves a username and password in the application's existing secret/configuration system.
2. Automatically signs in to Tadoku when a sync needs authentication.
3. Obtains the resulting `ory_kratos_session` cookie and stores it in the application's secret/configuration system.
4. Reuses that cookie for Tadoku immersion API requests and later exports for as long as Tadoku accepts it.
5. Repeats the login flow only when no saved cookie exists or Tadoku rejects it with HTTP 401.
6. Never returns, logs, displays, or includes the saved password in API responses.

Do not ask the user to copy an `ory_kratos_session` cookie or paste a native session token.

## Important Verified Behavior

Tadoku uses Ory Kratos for authentication. There are two relevant login flow types, but only one works for the immersion API:

- The native API login flow can return a valid `session_token`.
- That token works with the Kratos identity endpoint when sent as `X-Session-Token`.
- Tadoku's immersion API nevertheless returns HTTP 401 for that native token, including when it is sent as `X-Session-Token` or `Authorization: Bearer ...`.
- The immersion API accepts the `ory_kratos_session` cookie created by the browser login flow.

Therefore, use the browser login flow described below. Do not implement the native `/self-service/login/api` token flow for immersion requests.

## Verified Endpoints

Authentication base URL:

```text
https://account.tadoku.app/kratos/
```

Start a browser login flow:

```text
GET https://account.tadoku.app/kratos/self-service/login/browser
Accept: application/json
```

Immersion API base URL:

```text
https://tadoku.app/api/internal/immersion/
```

Example authenticated read:

```text
GET https://tadoku.app/api/internal/immersion/logs/configuration-options
```

Use one cookie-aware HTTP session for the entire login and immersion request sequence. Seed new HTTP sessions with the saved cookie before making an immersion request.

## Login Flow

1. Create a new cookie-aware HTTP session, such as `requests.Session` in Python.
2. Send `GET /self-service/login/browser` with `Accept: application/json`.
3. Confirm the response is successful and parse the JSON.
4. Read `ui.action` from the response. Treat it as untrusted input and verify that it begins with:

   ```text
   https://account.tadoku.app/kratos/self-service/login?
   ```

5. Find the node in `ui.nodes` whose `attributes.name` is `csrf_token` and read its `attributes.value`.
6. The initial GET also sets a CSRF cookie. Keep it in the same HTTP session.
7. Submit a form-encoded `POST` to `ui.action` using the same HTTP session and these fields:

   ```text
   identifier=<saved username or email>
   password=<saved password>
   method=password
   csrf_token=<value extracted from ui.nodes>
   ```

   Send these as form data, not JSON. Include `Accept: application/json`.

8. Confirm the response is successful.
9. Confirm the session cookie jar contains a non-empty cookie named `ory_kratos_session`.
10. Make immersion API calls through the same HTTP session. Do not manually copy the cookie into a header, and do not send the native session token.

## Python Reference Shape

Use this as structural guidance rather than blindly copying it into a different architecture:

```python
import requests

AUTH_BASE_URL = "https://account.tadoku.app/kratos/"
IMMERSION_BASE_URL = "https://tadoku.app/api/internal/immersion/"
TIMEOUT_SECONDS = 20


class TadokuAuthenticationError(RuntimeError):
    pass


class TadokuClient:
    def __init__(self, username: str, password: str, session_cookie: str = ""):
        self.username = username.strip()
        self.password = password
        self.session = requests.Session()
        if session_cookie:
            self.session.cookies.set(
                "ory_kratos_session",
                session_cookie,
                domain=".tadoku.app",
                path="/",
                secure=True,
            )

        if not self.username or not self.password:
            raise TadokuAuthenticationError("Tadoku username and password are not configured")

    def has_session_cookie(self) -> bool:
        return any(
            cookie.name == "ory_kratos_session" and bool(cookie.value)
            for cookie in self.session.cookies
        )

    def login(self) -> None:
        flow_response = self.session.get(
            f"{AUTH_BASE_URL}self-service/login/browser",
            headers={"Accept": "application/json"},
            timeout=TIMEOUT_SECONDS,
        )
        flow_response.raise_for_status()
        flow = flow_response.json()

        ui = flow.get("ui") or {}
        action = str(ui.get("action") or "")
        expected_prefix = f"{AUTH_BASE_URL}self-service/login?"
        if not action.startswith(expected_prefix):
            raise TadokuAuthenticationError("Tadoku returned an invalid login flow")

        csrf_token = next(
            (
                str((node.get("attributes") or {}).get("value") or "")
                for node in ui.get("nodes", [])
                if (node.get("attributes") or {}).get("name") == "csrf_token"
            ),
            "",
        )
        if not csrf_token:
            raise TadokuAuthenticationError("Tadoku did not return a CSRF token")

        login_response = self.session.post(
            action,
            data={
                "identifier": self.username,
                "password": self.password,
                "method": "password",
                "csrf_token": csrf_token,
            },
            headers={"Accept": "application/json"},
            timeout=TIMEOUT_SECONDS,
        )
        if not login_response.ok:
            raise TadokuAuthenticationError(
                "Tadoku login failed; check the saved username and password"
            )
        if not self.has_session_cookie():
            raise TadokuAuthenticationError(
                "Tadoku login did not return a browser session cookie"
            )

    def request(self, method: str, path: str, **kwargs):
        if not self.has_session_cookie():
            self.login()
        response = self.session.request(
            method,
            f"{IMMERSION_BASE_URL}{path.lstrip('/')}",
            timeout=TIMEOUT_SECONDS,
            **kwargs,
        )
        if response.status_code == 401:
            for cookie in list(self.session.cookies):
                if cookie.name == "ory_kratos_session":
                    self.session.cookies.clear(cookie.domain, cookie.path, cookie.name)
            self.login()
            response = self.session.request(
                method,
                f"{IMMERSION_BASE_URL}{path.lstrip('/')}",
                timeout=TIMEOUT_SECONDS,
                **kwargs,
            )
        return response
```

After a login or refresh, read `ory_kratos_session` from the cookie jar and persist its value without logging or returning it. Seed the next `TadokuClient` with that saved value.

If an immersion request returns HTTP 401, discard the rejected `ory_kratos_session` cookie, perform the browser login flow once, retry the request once, and persist the replacement cookie. Never retry authentication indefinitely.

## Configuration and UI Requirements

Replace the old session-cookie/token setting with fields equivalent to:

```text
tadoku_username
tadoku_password
tadoku_session_cookie
```

Recommended behavior:

- Returning settings may include the saved username so the UI can populate it.
- Returning settings must never include the password.
- Returning settings must never include the internal session cookie.
- A blank password input should preserve an already saved password.
- Provide an explicit “clear saved Tadoku login” control that clears both username and password.
- Consider the integration configured only when both username and password are non-empty.
- Use `autocomplete="username"` and `autocomplete="current-password"` in an HTML form.
- Explain that the application signs in automatically and creates a fresh Tadoku session.
- Treat the session cookie as an internal field; do not provide a manual cookie-entry UI.
- Reuse a saved cookie until Tadoku returns HTTP 401, then replace it automatically using the saved credentials.
- Provide a manual “Refresh Tadoku login” action that forces a new credential login, replaces the saved cookie, and reports success without exposing the cookie.

Use the host application's established credential storage mechanism. If it has an OS keychain or encrypted secret store, prefer it over plain configuration. Never print credentials while testing.

## Error Handling and Security

- Apply request timeouts to both authentication and immersion calls.
- Convert network errors into clear, non-secret-bearing application errors.
- Do not include the submitted identifier, password, CSRF value, session cookie, or full authentication response in logs.
- Return a generic invalid-credentials message for unsuccessful login submissions.
- Validate `ui.action` before posting credentials to prevent credential exfiltration through a malicious or malformed response.
- Persist the acquired session cookie using the same protection as other application secrets. It must never appear in settings responses or logs.
- Avoid dumping cookie jars, request bodies, or configuration contents in test output.

## Manual Authentication Refresh

Add a user-facing button labeled similarly to:

```text
Refresh Tadoku login
```

Place it near the action that saves the Tadoku settings. The user must save their username and password before invoking it; do not submit unsaved password fields through the refresh action.

Back the button with a dedicated endpoint, for example:

```text
POST /api/tadoku/auth/refresh
```

The endpoint must:

1. Load the saved Tadoku username and password from configuration.
2. Return HTTP 400 with a safe message when either credential is missing.
3. Create a new cookie-aware Tadoku client without seeding it with the existing session cookie.
4. Force the complete browser login and CSRF flow even if a previous cookie is still valid.
5. Confirm that login produced a non-empty `ory_kratos_session` cookie.
6. Replace `tadoku_session_cookie` in configuration and persist it.
7. Return a minimal response such as `{"authenticated": true}` without returning the username, password, CSRF token, or cookie.
8. Return a safe authentication error when Tadoku rejects the login.

Do not clear or overwrite the previously persisted cookie until the replacement login succeeds. This lets a failed manual refresh leave the last potentially usable session intact.

Recommended client method:

```python
def refresh_session(self) -> None:
    self._clear_session_cookie()
    self.login()
```

The UI should:

- Disable the refresh button while the request is running.
- Temporarily display progress text such as `Refreshing…`.
- Show a clear success message when the replacement session is saved.
- Show the safe server error when refresh fails.
- Restore the button text and enabled state in a `finally` path.
- Never display or inspect the returned cookie.

Changing the saved Tadoku username or password should invalidate the internally saved session cookie so the next sync cannot accidentally continue under credentials for a previous account. Clearing the saved login should clear the username, password, and session cookie together.

## Tests to Add

Use mocked HTTP responses for automated tests. Cover at least:

1. Missing username or password is rejected before a network request.
2. The browser login flow endpoint is requested.
3. The CSRF token is extracted from `ui.nodes`.
4. Credentials, `method=password`, and the CSRF token are submitted as form data.
5. A missing or untrusted `ui.action` is rejected.
6. A missing CSRF token is rejected.
7. Invalid credentials produce a safe error without exposing the password.
8. A successful login must create `ory_kratos_session` in the cookie jar.
9. Immersion requests reuse a saved cookie without performing another login.
10. The settings API returns the username but never returns the password.
11. Clearing credentials clears both values.
12. The integration is considered configured only when both values are present.
13. HTTP 401 causes exactly one relogin/retry and persists the replacement cookie.
14. The manual refresh endpoint rejects missing credentials without attempting login.
15. Manual refresh forces login, persists the new cookie, and returns no secrets.
16. Failed manual refresh does not overwrite the previously saved cookie.
17. The refresh button is rendered and restores its enabled state after success or failure.
18. Changing or clearing credentials invalidates the saved session cookie.

## Live Verification

Only perform live verification when the user explicitly authorizes use of their saved credentials. Tell the user when the credentials have been read so they can reset the password afterward. Never display the values.

Use read-only Tadoku calls for verification:

1. Complete the browser login flow.
2. Verify that the cookie jar contains `ory_kratos_session` without printing its value.
3. Request `logs/configuration-options` and confirm HTTP 200 with a `units` list.
4. Optionally request ongoing registrations and confirm the response parses.
5. Do not create, edit, or delete Tadoku logs during authentication testing.

## Completion Criteria

The task is complete when:

- The user can save a Tadoku username and password instead of a cookie/token.
- A real sync automatically performs the browser login flow.
- The same session successfully calls the immersion API without HTTP 401.
- Later syncs reuse the saved session without logging in again while it remains valid.
- An expired session is refreshed and persisted without user intervention.
- A manual refresh button can force and persist a replacement session on demand.
- Passwords and session cookies are absent from settings responses and logs.
- Focused authentication, settings, and sync tests pass.

Report any unrelated pre-existing test or lint failures separately rather than changing unrelated code.
