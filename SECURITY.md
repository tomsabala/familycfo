# Security

This app holds a household's complete financial picture and the logins to its banks, so please read this before
running it.

## The model

- It is meant to run on **one trusted computer**, for the people who live with that data. The API binds to
  `127.0.0.1` and has **no authentication** — anything that can reach that port can read everything. Don't expose it
  through a reverse proxy, a tunnel, port forwarding, or a `0.0.0.0` bind.
- Requests are only answered when the `Host` header is a loopback name (`127.0.0.1`, `localhost`, `::1`) and the
  `Origin`, if any, is loopback too. That is what stops a website you visit from reaching the API with a DNS name
  rebound to `127.0.0.1` — a browser treats such a page as same-origin, so the loopback bind alone wouldn't.
- Bank logins are read from `accounts.json` (git-ignored). Treat that file like a password vault: keep the computer's
  disk encrypted and its user account locked. Where your bank supports it, use a read-only / viewing user for scraping.
- `bank.db`, `backups/` and `data/` hold the data itself — keep them out of git, cloud-synced folders you share, and
  bug reports.
- The data chat runs your own Claude Code CLI with only read access to the database and to `data/`. What it reads is
  sent to Anthropic under your account to answer you. It works in a private directory of its own
  (`$TMPDIR/household-agent-<uid>`, mode `0700`); the copies of your documents it reads there are deleted as soon as
  it finishes answering.
- `npm run demo` deletes the database it builds, so it refuses to run when `BANK_DB` points at anything but a
  `demo*.db` (override with `npm run demo -- --force`).

## Hosted instance

The `HOSTED=1` build (the container behind `apps.tom-sabala.dev/a/familycfo/`) deliberately breaks
the first two rules above, and replaces them with these:

- It binds `0.0.0.0`, because only the gateway can reach the container's private Docker network.
  The loopback `Host` check is replaced by a **same-origin check**: a request carrying an `Origin`
  is refused unless its host equals the request's `Host`. The `Host` itself is not pinned — the
  gateway's readiness probe addresses the container by IP, so a fixed name would reject it.
- There is still **no login**. What separates two visitors is that they are in two different
  containers; the per-session container and the gateway's signed session cookie are the whole
  boundary. The app has one household per database file, so the container is the tenancy boundary.
- Bank logins are typed into the app, not read from `accounts.json`. They are encrypted with
  AES-256-GCM into `provider_credentials` in that container's own database, under a 32-byte key in a
  `0600` `.secret_key` file beside it. Plaintext exists only in memory while a scrape runs. No
  endpoint ever returns a field value — `GET /api/credentials` returns the provider, the last four
  characters of the first non-password field, and a timestamp. Credential values are scrubbed out of
  logs, of `scrape_runs` and of any error text echoed back by a bank site, and the library's
  `verbose` trace and the failed-page dump are both disabled there.
- For an anonymous session, database and key live on a tmpfs and are destroyed with the container.
  An admin instance keeps both on a named Docker volume until `docker volume rm` removes it.
- `/api/scrape` is public there, so it is rate-limited per container: one run every two minutes, 20
  per container lifetime, one at a time.
- TLS terminates at the gateway; gateway → container is plaintext HTTP on a private Docker network.
  The container has no egress allow-list.
- The data chat is off and cannot be enabled: it spawns the user's own `claude` CLI and would run
  with the operator's credentials, not the visitor's.

Using the hosted app means trusting the operator of that VPS with the bank login you type into it.
Running it locally is still the recommended way to use real credentials.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability** on the repository) and include the steps to reproduce. Never attach real
credentials or financial data.
