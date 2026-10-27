# Self-hosted reimplementation of the Mailspring API

Free reimplementation of the Mailspring Sync backend (and other required APIs). This project provides an alternative sync server that can be self-hosted for the [Mailspring Email Client](https://getmailspring.com/).

**🔴IMPORTANT🔴** This project only works with a Mailspring client build that allows configuring a custom API server — the official client hardcodes `getmailspring.com`. [irfanMiral/Mailspring](https://github.com/irfanMiral/Mailspring) (or [1RandomDev/Mailspring](https://github.com/1RandomDev/Mailspring), which it's based on) both support this.

## About this fork

This is a fork of [1RandomDev/mailspring-api](https://github.com/1RandomDev/mailspring-api), which had been unmaintained since 2023 while the Mailspring client kept shipping new features. This fork exists to keep the backend working against a current client, fix bugs found along the way, and add support for features the original project's client version predates. See [CHANGES.md](CHANGES.md) for what's changed.

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
- :heavy_check_mark: Account dashboard (`/dashboard`) - change password, view/revoke active sessions
- :x: Rich contact profile
- :x: Company overviews
- :heavy_check_mark: Mailbox insights (+ sharing)
- :heavy_check_mark: Translation (using Google Translate)
- :heavy_check_mark: Thread sharing

## Install
### Docker Compose + Caddy (HTTPS, recommended)
This repo ships a `docker-compose.yml` and `deploy/Caddyfile` that run the API behind
[Caddy](https://caddyserver.com) with automatic Let's Encrypt certificates on three
subdomains of one domain:

| host | serves | who calls it |
|---|---|---|
| `id.<DOMAIN>` | `/api/*`, `/metadata/*`, `/deltas/*`, `/login`, `/onboarding`, `/dashboard` | the client (`rootURLForServer('identity')`) and the sync engine (`IDENTITY_SERVER`) |
| `link.<DOMAIN>` | `/o/*`, `/open/*`, `/link/*` only | anyone who opens/clicks a tracked mail (public) |
| `share.<DOMAIN>` | `/thread/*`, `/page/*`, `/asset/*`, `/signature-assets/*` only | anyone with a share link (public) |

Shared pages and assets are user-supplied HTML/files, so they are only served on
`share.`; the `id.` host returns 404 for them and for the tracking paths. The API
container is not published on a host port.

1. DNS: point `id.<DOMAIN>`, `link.<DOMAIN>` and `share.<DOMAIN>` (A/AAAA) at the server.
   Ports 80 and 443 must be reachable for certificate issuance.
2. Configure and start:
   ```bash
   git clone <this repo> mailspring-api && cd mailspring-api
   cp .env.example .env    # set DOMAIN=<DOMAIN>
   mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000
   docker compose --profile caddy up -d --build
   ```
3. Create a user (there is no sign-up page):
   ```bash
   docker compose exec api ./manage.js user add --fullName "First Last" --email "you@example.com" --password "..."
   ```
4. Point the client at it: see [docs/client-changes.md](docs/client-changes.md).

#### Host already runs nginx (instead of Caddy)
`docker compose up -d --build` (without `--profile caddy`) starts only the API, published on
`127.0.0.1:5101`. Then, with DOMAIN=`api.example.com` as an example:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/mailspring-api
sudo sed -i 's/api\.example\.com/<DOMAIN>/g' /etc/nginx/sites-available/mailspring-api
# get the certificate first (one cert, three names), nginx must already answer on :80 for them
sudo certbot certonly --webroot -w /var/www/html -d id.<DOMAIN> -d link.<DOMAIN> -d share.<DOMAIN>
sudo ln -s /etc/nginx/sites-available/mailspring-api /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

certbot's renewal timer keeps the certificate fresh; add
`--deploy-hook "systemctl reload nginx"` to the certonly command so nginx picks it up.

Resources: the API process uses roughly 90 MB RSS idle (measured), SQLite needs no
separate service; a 1 GB / 2 vCPU VPS is enough. `npm install` inside `docker build`
may compile `better-sqlite3` if no prebuilt binary matches; add swap if the build gets
OOM-killed on a 1 GB host.

Data lives in `./data` (SQLite, WAL mode). Back up the whole directory while the
container is stopped, or use `sqlite3 data/mailspring-api.db ".backup backup.db"`.

Exposure:
- Tracking (`link.`) and share (`share.`) endpoints are intentionally public.
- There is no admin web UI; user management is only `manage.js` via `docker compose exec`.
- `/login`, `/onboarding` and `/dashboard` must stay reachable for the client's sign-in
  webview. They have no rate limiting: put fail2ban (or similar) on Caddy's JSON access
  log for `POST /login` responses with status 401 if the server is exposed to the internet.
- Grammar check sends composer text to `LANGUAGETOOL_URL` (public LanguageTool by
  default) and translation sends message text to Google Translate.

Compatibility notes, test coverage and the list of endpoints the current client uses:
[docs/compat.md](docs/compat.md). Run the tests with `npm test`.

### Using Docker Compose
docker-compose.yml
```yaml
version: "3.4"

services:
  mailspring-api:
    container_name: mailspring-api
    image: ghcr.io/irfanmiral/mailspring-api:latest
    network_mode: bridge
    ports:
      - 5101:5101/tcp
    volumes:
      - ./data:/data
    environment:
      - TZ=<timezone>
      - SHARE_URL=https://<my_public_domain>
    restart: unless-stopped
```
### Using Docker CLI
```bash
docker run -d --name=mailspring-api \
    --network=bridge \
    -p 5101:5101/tcp \
    -v <data_directory>:/data \
    -e TZ=<timezone> \
    -e SHARE_URL=https://<my_public_domain> \
    ghcr.io/irfanmiral/mailspring-api:latest
```

### Install on the host
```bash
git clone https://github.com/irfanMiral/Mailspring-API.git && cd Mailspring-API
npm install

./manage.js user add --fullName "..." --email "..." --password "..."
npm start
```

## Environment variables
| Variable | Description | Default |
|----------|-------------|---------|
| LOG_LEVEL | Set custom log level. [Available log levels](https://github.com/winstonjs/winston#logging-levels). | `info` |
| SHARE_URL | External url for shared resources. (Should be on a different domain for securrity purposes.) | `http://localhost:5101` |
| API_PORT | The port that is used for the webinterface and the API. | 5101 |
| LANGUAGETOOL_URL | Base URL of a [LanguageTool](https://languagetool.org/)-compatible grammar check server, used for the composer's grammar check feature. Defaults to the public LanguageTool API, which is rate-limited; point this at a self-hosted instance (e.g. the [erikvl87/languagetool](https://hub.docker.com/r/erikvl87/languagetool) Docker image) to avoid that. | `https://api.languagetool.org` |

## Create/Manage a user account
You can create a new user account using the CLI tool.
```bash
docker exec -it mailspring-api ./manage.js user add --fullName "..." --email "..." --password "..."
```
For more info use
```bash
$ docker exec -it mailspring-api ./manage.js user --help
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
