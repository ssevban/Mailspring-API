# Self-hosted reimplementation of the Mailspring API

Free reimplementation of the Mailspring Sync backend (and other required APIs). This project provides an alternative sync server that can be self-hosted for the [Mailspring Email Client](https://getmailspring.com/).

**IMPORTANT:** the official Mailspring client hardcodes `getmailspring.com`. This server needs a client build pointed at it; see [docs/client-changes.md](docs/client-changes.md) for the minimum changes.

## Origin

This repository is maintained by [ssevban](https://github.com/ssevban). It is a fork of [irfanMiral/Mailspring-API](https://github.com/irfanMiral/Mailspring-API), which itself is a fork of the original [1RandomDev/mailspring-api](https://github.com/1RandomDev/mailspring-api). Licensed under GPL-3.0 like both upstreams.

- Changes made in irfanMiral's fork: [CHANGES.md](CHANGES.md)
- Changes made in this fork (client compatibility fixes, tracking hardening, single-host nginx deploy): [docs/compat.md](docs/compat.md)

## Supported Features
- :heavy_check_mark: Metadata Sync
- :heavy_check_mark: Multiple user accounts
- :heavy_check_mark: Read Receipts
- :heavy_check_mark: Link Tracking
- :heavy_check_mark: Follow-up Reminders
- :heavy_check_mark: Snooze messages
- :heavy_check_mark: Send Later
- :heavy_check_mark: Mail Templates
- :heavy_check_mark: Grammar check (proxies to a [LanguageTool](https://languagetool.org/)-compatible server)
- :heavy_check_mark: CalDAV/CardDAV host discovery (for the client's own calendar/contacts sync, which talks to your mail provider directly)
- :heavy_check_mark: Account dashboard (`/dashboard`) - change password, view/revoke active sessions (blocked in `deploy/nginx.conf`, the client doesn't need it)
- :x: Rich contact profile / Company overviews (see below)
- :heavy_check_mark: Mailbox insights (sharing them is blocked in `deploy/nginx.conf`)
- :heavy_check_mark: Translation (using Google Translate)
- :x: Thread sharing (implemented, but blocked in `deploy/nginx.conf`, see below)

### Not supported
- **Rich contact profile / Company overviews**: the client's sidebar asks
  `/api/info-for-email-v2/<email>` for a person and company profile with the same fields as
  Clearbit's enrichment API. Clearbit's free APIs were shut down in 2025 after the HubSpot acquisition
  ([changelog](https://developers.hubspot.com/changelog/upcoming-sunset-of-clearbits-free-logo-api))
  and the replacements need an API key or a subscription, so this server doesn't implement
  the endpoint. The client handles the missing endpoint and shows only the contact's name
  and email.
- **Thread sharing**: `/api/save-public-asset` and `/thread/<identityId>/<key>` work, but a
  shared thread is someone else's mail HTML rendered on the API's origin, next to the
  session cookie, so `deploy/nginx.conf` returns 404 for `/thread/` and `/page/`. To enable
  it, serve those paths from a separate host (e.g. `share.example.com`, its own nginx server
  block that proxies only `/thread/` and `/page/`) and change the link the client builds,
  which is hardcoded to `https://shared.getmailspring.com/thread/...` in
  `app/internal_packages/thread-sharing/lib/main.tsx`.

## Install
### Docker image + host nginx (recommended)
One host (e.g. `link.api.example.com`) serves everything: identity/metadata sync for the
client and sync engine, and the public open/link tracking URLs. Thread sharing and shared
activity pages (`/thread/`, `/page/`) are disabled in `deploy/nginx.conf`.

Build on your own machine, copy the image to the server:

```bash
# on your machine (use the server's arch: `uname -m` x86_64 -> linux/amd64, aarch64 -> linux/arm64)
docker build --platform linux/amd64 -t mailspring-api:1 .
docker save mailspring-api:1 | gzip > mailspring-api-1.tar.gz
scp mailspring-api-1.tar.gz user@server:/tmp/
```

On the server (nginx already installed, DNS A record of the host points at it):

```bash
gunzip -c /tmp/mailspring-api-1.tar.gz | docker load
sudo mkdir -p /opt/mailspring-api/data && sudo chown 1000:1000 /opt/mailspring-api/data
docker run -d --name mailspring-api --restart unless-stopped \
    -p 127.0.0.1:5101:5101 \
    -v /opt/mailspring-api/data:/data \
    -e SHARE_URL=https://link.api.example.com \
    mailspring-api:1
docker exec -it mailspring-api node manage.js user add --fullName "First Last" --email "you@example.com" --password "..."

# nginx site (copy deploy/nginx.conf to the server first)
sudo cp nginx.conf /etc/nginx/sites-available/mailspring-api
sudo sed -i 's/link\.api\.example\.com/<your host>/' /etc/nginx/sites-available/mailspring-api
sudo ln -s /etc/nginx/sites-available/mailspring-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <your host>     # adds HTTPS + redirect to that server block
```

Check: `curl -sI https://<your host>/o/AAAA.png` -> 200 `image/png`, `curl -s -o /dev/null -w '%{http_code}' https://<your host>/api/me` -> 401.

Notes:
- The container runs as uid 1000, so the data dir must be owned by 1000.
- Data is one SQLite file in `/opt/mailspring-api/data` (WAL mode); back up the directory while the container is stopped.
- The API process uses about 90 MB RSS (measured); fine on a 1 GB / 2 vCPU VPS.
- `/onboarding` and `/login` must stay reachable for the client's sign-in webview. nginx limits `POST /login` to 5 requests/minute per IP; `/` and `/dashboard` return 404.
- `docker-compose.yml` is an optional equivalent of the `docker run` above (`PUBLIC_URL` in `.env`).
- Compatibility notes and tests: [docs/compat.md](docs/compat.md), `npm test`. Client changes: [docs/client-changes.md](docs/client-changes.md).

### Prebuilt image from GHCR (GitHub Actions)
`.github/workflows/docker-build.yml` builds the image on every push to `master` (tag
`latest` and `sha-<commit>`) and on `v*.*.*` tags, and pushes it to
`ghcr.io/ssevban/mailspring-api`. The server then only pulls, no build there.

One-time: on a fork, enable workflows under the repository's Actions tab. After the first
build, either make the package public (GitHub > Packages > mailspring-api > Package
settings > Change visibility) or `docker login ghcr.io` on the server with a token that
has `read:packages`.

Deploy / update on the server:

```bash
docker pull ghcr.io/ssevban/mailspring-api:latest
docker rm -f mailspring-api
docker run -d --name mailspring-api --restart unless-stopped \
    -p 127.0.0.1:5101:5101 \
    -v /opt/mailspring-api/data:/data \
    -e SHARE_URL=https://link.api.example.com \
    ghcr.io/ssevban/mailspring-api:latest
docker image prune -f
```

The data directory survives the container being replaced. To roll back, run a previous
`sha-<commit>` tag instead of `latest`.

### Install on the host
```bash
git clone https://github.com/ssevban/Mailspring-API.git && cd Mailspring-API
npm install

node manage.js user add --fullName "..." --email "..." --password "..."
npm start
```

## Environment variables
| Variable | Description | Default |
|----------|-------------|---------|
| LOG_LEVEL | Set custom log level. [Available log levels](https://github.com/winstonjs/winston#logging-levels). | `info` |
| SHARE_URL | Public URL of this server, used in links to uploaded assets (e.g. signature photos). | `http://localhost:5101` |
| API_PORT | The port that is used for the webinterface and the API. | 5101 |
| LANGUAGETOOL_URL | Base URL of a [LanguageTool](https://languagetool.org/)-compatible grammar check server, used for the composer's grammar check feature. Defaults to the public LanguageTool API, which is rate-limited; point this at a self-hosted instance (e.g. the [erikvl87/languagetool](https://hub.docker.com/r/erikvl87/languagetool) Docker image) to avoid that. | `https://api.languagetool.org` |

## Create/Manage a user account
You can create a new user account using the CLI tool.
```bash
docker exec -it mailspring-api node manage.js user add --fullName "..." --email "..." --password "..."
```
For more info use
```bash
$ docker exec -it mailspring-api node manage.js user --help
manage.js user <operation> [options]

Magage user accounts.

Commands:
  manage.js user add [options]       Create a new user.
  manage.js user delete [options]    Delete a user.
  manage.js user changepw [options]  Change the password of a user.
  manage.js user info [options]      Show details about a user.
  manage.js user list                List all users.

Options:
  -h, --help     Show help                                             [boolean]
  -v, --version  Show version number                                   [boolean]
```
