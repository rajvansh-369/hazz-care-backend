# Staging checklist — run AFTER deploying, through the real hostname

Everything here goes through the public hostname, the TLS terminator and whatever proxy, CDN or
gateway the platform puts in front. That layer is where most of these break, and none of the
repo's tests can see it. Replace `<staging-host>` throughout. Do not hand the base URL to the app
developer until every box is ticked.

- [ ] **`npm run db:sync-indexes` ran against the staging database** before this version took
      traffic, and printed `Indexes in sync.`

- [ ] **The contract checker is green, every section**, with `OTP_EMAIL` set to a mailbox you
      can read (on the VPS: the staging Gmail address):
      ```bash
      OTP_EMAIL=<your inbox> npm run contract -- https://<staging-host>/api/v1
      ```
      Staging sends real email, so `OTP_EMAIL` is required there: every account the run
      registers becomes a `+contract-<stamp>-<n>` alias of that inbox, and nothing is sent to a
      domain that does not exist (bounces hurt the sender's reputation). Section 13 pauses and
      asks for the 6-digit code emailed to the address the run prints (the newest
      *Your HajjCare password reset code* in that inbox); type it in within 10 minutes. Run it
      in a terminal: without one, section 13 is skipped.

- [ ] **An unknown auth path is NOT 404:**
      ```bash
      curl -i https://<staging-host>/api/v1/auth/nope
      ```
      Expect `503` with `{"code":"unavailable"}`. Hosting platforms and CDNs answer with their own
      HTML 404/502 pages, and the app renders **any** 404 as *"We could not find an account for
      that email address"*, whatever the body.

- [ ] **Nothing authenticates `/auth/refresh` in front of the app** — no API-gateway key, WAF
      challenge or platform auth. A JSON `401`/`403` there **signs the pilgrim out**. Check the
      same for register, forgot-password, verify-otp and reset-password, where a 401/403 shows
      *"That email and password do not match"*.

- [ ] **No redirects on the API hostname** — not HTTP→HTTPS, not trailing slash, not `www`. The
      app follows no redirects. Both of these must answer directly, never `301`/`302`/`307`/`308`:
      ```bash
      curl -si -X POST https://<staging-host>/api/v1/auth/logout -H 'Content-Type: application/json' -d '{"refreshToken":""}' | head -1   # 204
      curl -si https://<staging-host>/api/v1/health/ | head -1
      ```

- [ ] **forgot-password answers well under 15 seconds** (the app's receive timeout), for a known
      and an unknown address alike, including the first request after the instance has been idle:
      ```bash
      curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' -X POST https://<staging-host>/api/v1/auth/forgot-password -H 'Content-Type: application/json' -d '{"email":"<registered address>"}'
      curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' -X POST https://<staging-host>/api/v1/auth/forgot-password -H 'Content-Type: application/json' -d '{"email":"nobody-<random>@example.com"}'
      ```
      Both `200`, both around the same time. A platform that sleeps idle instances can blow the
      15 seconds on a cold start: turn that off.

- [ ] **The OTP email arrives in under a minute, from the real sender, in the inbox (not spam).**
      Check Gmail and Outlook at least, and look at the headers for SPF and DKIM `pass`.

- [ ] **Exactly one instance is running** (docs/DEPLOY.md §4), and `TRUST_PROXY` matches the
      number of proxies in front of it (§5).
