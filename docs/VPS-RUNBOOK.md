# VPS runbook — HajjCare API on one Ubuntu server

Docker Compose runs MongoDB 7 (one-node replica set, never published) and the API. Something
in front terminates HTTPS. Which one depends on the server:

- **Server that already runs nginx — the staging VPS.** The host's nginx is the reverse proxy
  and TLS terminator, with a certificate from certbot. The API is published on
  `127.0.0.1:5100` only. First section below.
- **Dedicated server with no web server.** Caddy runs in the stack (compose profile `caddy`)
  and gets its own Let's Encrypt certificate. Second section below.

Files: `docker-compose.prod.yml`, `docker-compose.prod.host-nginx.yml`, `deploy/dc.sh`,
`deploy/nginx/api-staging.healthhub4u.co.uk.conf`, `deploy/Caddyfile`,
`deploy/caddy.env.example`, `.env.production.example`, `deploy/backup-mongo.sh`,
`deploy/restore-mongo.sh`. Background and every variable: [DEPLOY.md](DEPLOY.md).

**Staging hostname: `api-staging.healthhub4u.co.uk`**; the app's base URL is `https://api-staging.healthhub4u.co.uk/api/v1`.
`<vps-ip>` is the server's public IPv4 address and `deploy` the login user. Commands marked
*laptop* run on your machine; everything else on the VPS.

---

## Server that already runs nginx (the staging VPS)

The staging VPS (Ubuntu 24.04, `57.128.170.115`) already serves other live websites from nginx
on ports 80 and 443, IPv4 and IPv6. Caddy cannot bind those ports, and **the existing sites must
not be disturbed.** So on this server:

- the compose stack runs `mongo` + `api` only (Caddy is in a profile a plain `up` never starts);
- the API is published on **`127.0.0.1:5100` only** (`docker-compose.prod.host-nginx.yml`);
- the host's nginx proxies `api-staging.healthhub4u.co.uk` to it, and certbot supplies the
  certificate;
- **every compose command goes through `./deploy/dc.sh`**, which always passes both compose
  files. Never type `docker compose -f …` by hand here: forgetting the override leaves the API
  unreachable, and any port other than a `127.0.0.1:` one would publish it to the internet
  around nginx (Docker's published ports bypass UFW).

`TRUST_PROXY` stays `1`: nginx is exactly one hop.

Prerequisites, from the dedicated-server section further down (they are the same here):
DNS for the hostname (an A record `api-staging` → `57.128.170.115`, and an AAAA record only if
it is this server's own IPv6 address, since nginx here also listens on IPv6), the outbound SMTP
check (b), Docker (e) — skip it if `docker compose version` already works — the code (f) and
the Gmail App Password (h).

### a. Never stop or restart nginx

Other sites are live on it. The only nginx commands in this runbook are:

```bash
sudo nginx -t                        # validate the whole configuration
sudo systemctl reload nginx          # only after `nginx -t` succeeded
```

**If `sudo nginx -t` fails, do not reload.** Undo the last change (remove the symlink from
`/etc/nginx/sites-enabled/`) and run `sudo nginx -t` again until it passes. Never
`systemctl stop`, `systemctl restart`, or `nginx -s stop`.

Before changing anything, record how the existing sites answer, to compare in step g:

```bash
sudo nginx -T 2>/dev/null | grep -E '^\s*server_name' | sort -u | tee ~/nginx-sites-before.txt
for host in $(awk '{for (i=2;i<=NF;i++) print $i}' ~/nginx-sites-before.txt | tr -d ';' | grep -v '^_$' | sort -u); do
  printf '%-45s %s\n' "$host" "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$host/")"
done | tee ~/nginx-status-before.txt
sudo nginx -T 2>/dev/null | grep -n 'api-staging.healthhub4u.co.uk'   # must print nothing
grep -n 'sites-enabled' /etc/nginx/nginx.conf                        # the include step e relies on
```

If `api-staging.healthhub4u.co.uk` is already in some server block, stop and find out why before
going on.

### b. Check that port 5100 is free

```bash
sudo ss -tlnp | grep ':5100\b'       # must print NOTHING
```

If something already listens there, pick another port, export `API_HOST_PORT=<port>` for every
`./deploy/dc.sh` call (e.g. `echo 'export API_HOST_PORT=5101' >> ~/.bashrc`), and change
`proxy_pass http://127.0.0.1:5100;` in the nginx file to match.

### c. `.env.production` — and no `deploy/caddy.env`

```bash
cd ~/hajjcare
cp .env.production.example .env.production
chmod 600 .env.production
for key in JWT_ACCESS_SECRET OTP_HMAC_SECRET RC_WEBHOOK_SECRET; do
  sed -i "s|^$key=.*|$key=$(openssl rand -base64 48)|" .env.production
done
nano .env.production                 # SMTP_URL and EMAIL_FROM, as in step h further down
ls -l .env.production                # -rw------- deploy deploy
```

The API refuses to start while any secret is still `CHANGE_ME`. Keep a copy of the file in a
password manager. **Do not create `deploy/caddy.env` on this server** — Caddy does not run here.

### d. Start the stack

```bash
cd ~/hajjcare
./deploy/dc.sh up -d --build
./deploy/dc.sh ps
```

Expect `mongo` and `api` (healthy) Up, `rs-init` and `sync-indexes` **Exited (0)**, **no
`caddy`**, and `api` showing `127.0.0.1:5100->5000/tcp` — never `0.0.0.0:` or `[::]:`. Watch the
logs (Ctrl+C stops watching, not the services), then check the API directly on loopback:

```bash
./deploy/dc.sh logs -f api
curl -i http://127.0.0.1:5100/api/v1/health            # 200 {"status":"live"}
sudo ss -tlnp | grep ':5100\b'                          # 127.0.0.1:5100 only
```

### e. Install the nginx server block (HTTP first)

```bash
cd ~/hajjcare
sudo cp deploy/nginx/api-staging.healthhub4u.co.uk.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/api-staging.healthhub4u.co.uk.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
curl -i http://api-staging.healthhub4u.co.uk/api/v1/health     # 200 {"status":"live"}
```

(If `nginx.conf` has no `sites-enabled` include and uses `conf.d/` instead, copy the file to
`/etc/nginx/conf.d/` and skip the symlink.) If the last `curl` returns some other site's page,
DNS or `server_name` is wrong — fix that before certbot.

Do not add anything to this block by hand: no `error_page`, `proxy_intercept_errors`,
`try_files`, caching or `return`/`rewrite`. The app reads any 404 as *"no account for that
email"*, even with an HTML body, and a 401/403 from `/auth/refresh` signs the pilgrim out. The
comments in the file say why each line is there.

### f. Certificate with certbot

```bash
certbot --version && dpkg -l python3-certbot-nginx | tail -1    # already on this server?
# only if missing: sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api-staging.healthhub4u.co.uk
```

Answer the redirect question with **redirect** (HTTP → HTTPS). certbot edits only this server
block (it adds the 443 listeners, the certificate and the port-80 redirect) and reloads nginx
itself. Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -i https://api-staging.healthhub4u.co.uk/api/v1/health    # 200 {"status":"live"}
sudo certbot renew --dry-run                                     # must end in success
```

The HTTP → HTTPS redirect is fine for the app: it is only ever given the `https://` base URL,
so nothing it calls is redirected. Renewal runs from certbot's own systemd timer
(`systemctl list-timers | grep certbot`).

### g. The existing sites still answer as before

```bash
for host in $(awk '{for (i=2;i<=NF;i++) print $i}' ~/nginx-sites-before.txt | tr -d ';' | grep -v '^_$' | sort -u); do
  printf '%-45s %s\n' "$host" "$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$host/")"
done > ~/nginx-status-after.txt
diff ~/nginx-status-before.txt ~/nginx-status-after.txt && echo 'existing sites unchanged'
```

Any difference: remove the symlink added in step e, `sudo nginx -t && sudo systemctl reload
nginx`, and investigate before trying again. Also open one or two of the sites in a browser.

### h. Firewall: leave it alone

**Do not enable or reconfigure UFW on this shared server.** Nothing new needs opening: the API
is on `127.0.0.1` only, and 80/443 are already served by nginx. From the laptop, confirm the
API port is not reachable from outside:

```bash
curl -m 5 http://57.128.170.115:5100/api/v1/health    # laptop: must FAIL (timeout or refused)
```

### i. SSH hardening: skip it here

This server is shared and administered separately. Do not change its SSH configuration. The
SSH-hardening step (c) in the next section is for a dedicated server only.

### j. Backups, updating, rolling back — all through `deploy/dc.sh`

`deploy/backup-mongo.sh` and `deploy/restore-mongo.sh` go through `deploy/dc.sh` themselves.
Set up the daily backup cron, the restore test and a real restore exactly as in step j of the
next section.

Updating:

```bash
cd ~/hajjcare
~/hajjcare/deploy/backup-mongo.sh
git pull --ff-only
./deploy/dc.sh up -d --build
./deploy/dc.sh ps                     # sync-indexes Exited (0), api healthy, 127.0.0.1:5100 only
curl -i https://api-staging.healthhub4u.co.uk/api/v1/health
```

If the pull changed `deploy/nginx/api-staging.healthhub4u.co.uk.conf`, do **not** copy it over
the installed file: that would drop certbot's TLS lines. Apply the change to
`/etc/nginx/sites-available/api-staging.healthhub4u.co.uk.conf` by hand, then
`sudo nginx -t && sudo systemctl reload nginx`.

Rolling back: `git checkout <previous commit>`, then `./deploy/dc.sh up -d --build` (details in
step l of the next section). After changing SMTP settings in `.env.production`:
`./deploy/dc.sh up -d`.

Then run the staging checklist from the laptop, as in step n of the next section:
[DEPLOY-CHECKLIST.md](DEPLOY-CHECKLIST.md).

---

## Dedicated server with no web server (Caddy)

For a server where nothing else uses ports 80 and 443. Caddy runs in the compose stack
(profile `caddy`) and is the only thing that publishes ports. Every compose command here needs
`--profile caddy`; without it Caddy is not started. (`deploy/backup-mongo.sh` and
`deploy/restore-mongo.sh` use `deploy/dc.sh`, which works on this server too: they only `exec`
into `mongo`.)

### a. Requirements

- Ubuntu **22.04 or 24.04**, a public IPv4 address.
- **2 GB RAM or more** recommended. 1 GB works only with swap (below).
- DNS for `api-staging.healthhub4u.co.uk` set up as in the next section.

#### DNS for `api-staging.healthhub4u.co.uk`

In the DNS zone of `healthhub4u.co.uk`:

- **An A record: name `api-staging` → `<vps-ip>`** (the VPS's public IPv4 address).
- **IPv6:** if the VPS has an IPv6 address, either add a matching AAAA record (`api-staging` →
  the VPS's IPv6 address) or add **no** AAAA record at all. A wrong AAAA record breaks certificate
  issuance, and breaks the API for every client that connects over IPv6.
- **If the zone is on Cloudflare:** the record must be **DNS only (grey cloud), never proxied**
  (orange cloud). A proxy would put Cloudflare's own HTML error pages in front of the API (the
  app reads any 404 as *"no account for that email"*), add a second proxy hop (so
  `TRUST_PROXY=1` would be wrong and one pilgrim could rate-limit a whole hotel), and can get in
  the way of Let's Encrypt.

Check it from the laptop **before the first start** (step i); it must print `<vps-ip>` and
nothing else:

```bash
dig +short api-staging.healthhub4u.co.uk
dig +short AAAA api-staging.healthhub4u.co.uk      # empty, or the VPS's own IPv6 address
```

With 1 GB of RAM, add 2 GB of swap first:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### b. Check outbound SMTP FIRST

Many VPS providers block outbound mail ports on new servers. Without them the password-reset
email never leaves.

```bash
nc -vz smtp.gmail.com 465
nc -vz smtp.gmail.com 587
```

- `465 ... succeeded`: use the `smtps://…:465` URL from `.env.production.example`.
- 465 blocked, 587 open: use port 587 with STARTTLS instead:
  `SMTP_URL=smtp://YOUR_ADDRESS%40gmail.com:APP_PASSWORD@smtp.gmail.com:587?requireTLS=true`
- Both blocked: open a ticket asking the provider to unblock outbound SMTP, and wait.

Also confirm the clock is synchronised (RevenueCat signatures allow 5 minutes of skew):
`timedatectl` should show `System clock synchronized: yes`.

### c. A sudo user with SSH keys; no passwords, no root login

As root (first login):

```bash
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

From the laptop, in a **new** terminal, check you can get in: `ssh deploy@<vps-ip>`. Then, as
`deploy`:

```bash
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl restart ssh
```

(`00-` sorts before the cloud image's own `50-cloud-init.conf`, and sshd keeps the first value it
reads.) Keep the current session open and test `ssh deploy@<vps-ip>` from another terminal before
logging out.

### d. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw enable
sudo ufw status verbose
```

Note: Docker's published ports **bypass UFW**, so the firewall is not what keeps MongoDB private.
What does is that only Caddy publishes ports in `docker-compose.prod.yml` (80, 443). Never add a
`ports:` entry to `mongo` or `api`, and do not start this stack with `deploy/dc.sh`: its
override is for a server whose own nginx is the proxy.

### e. Docker Engine and the compose plugin (Docker's official apt repository)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
```

Log out and back in (the group change), then: `docker run --rm hello-world` and
`docker compose version`. Membership of the `docker` group is equivalent to root; give it only to
people who may administer the server.

### f. Get the code with a read-only deploy key

```bash
ssh-keygen -t ed25519 -f ~/.ssh/hajjcare_deploy -N '' -C 'hajjcare-vps-deploy'
cat ~/.ssh/hajjcare_deploy.pub
```

On GitHub: repository → *Settings → Deploy keys → Add deploy key*, paste the public key, leave
**Allow write access unticked**. Then:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/hajjcare_deploy
  IdentitiesOnly yes
EOF
git clone git@github.com:rajvansh-369/hazz-care-backend.git ~/hajjcare
cd ~/hajjcare
git checkout foundation_for_backend
```

### g. `.env.production`

```bash
cd ~/hajjcare
cp .env.production.example .env.production
chmod 600 .env.production
for key in JWT_ACCESS_SECRET OTP_HMAC_SECRET RC_WEBHOOK_SECRET; do
  sed -i "s|^$key=.*|$key=$(openssl rand -base64 48)|" .env.production
done
nano .env.production
```

In the editor set `SMTP_URL` and `EMAIL_FROM` from step h. The
API refuses to start while any secret is still `CHANGE_ME`. Keep a copy of this file somewhere
safe off the server (a password manager): the secrets cannot be recovered from the database.

### h. Gmail App Password (staging email)

1. Use a Gmail account for staging only. Open <https://myaccount.google.com/security> and turn on
   **2-Step Verification** (App Passwords do not exist without it).
2. Open <https://myaccount.google.com/apppasswords>, name it `HajjCare staging`, create.
3. Google shows 16 letters in four groups (`abcd efgh ijkl mnop`). Remove the spaces.
4. In `.env.production`:
   ```
   SMTP_URL=smtps://YOUR_ADDRESS%40gmail.com:abcdefghijklmnop@smtp.gmail.com:465
   EMAIL_FROM="HajjCare <YOUR_ADDRESS@gmail.com>"
   ```
   The `@` of the username is written `%40`. `EMAIL_FROM` must be the same Gmail address, or Gmail
   rewrites the sender. Never use the account's normal password. (On a Google Workspace account
   an administrator may have disabled App Passwords.)

### i. First start

**First, DNS must already resolve to this server.** Starting Caddy before it does makes Let's
Encrypt fail over and over, and repeated failures are rate-limited (you can be locked out of a
certificate for an hour or more):

```bash
dig +short api-staging.healthhub4u.co.uk          # must print this VPS's IP. If not: stop and wait for DNS.
```

Caddy gets its own env file, holding only the hostname (never `.env.production`, so it cannot
see the app's secrets):

```bash
cd ~/hajjcare
cp deploy/caddy.env.example deploy/caddy.env      # API_DOMAIN=api-staging.healthhub4u.co.uk
chmod 600 deploy/caddy.env
```

Then start everything:

```bash
docker compose -f docker-compose.prod.yml --profile caddy up -d --build
docker compose -f docker-compose.prod.yml --profile caddy ps
```

Expect `mongo`, `api` (healthy) and `caddy` Up, and `rs-init` and `sync-indexes` **Exited (0)**.
Only `caddy` shows published ports. Watch the logs (Ctrl+C stops watching, not the services):

```bash
docker compose -f docker-compose.prod.yml --profile caddy logs -f api caddy
```

Caddy gets the certificate within a minute of the first request to the name. Then, from the
laptop:

```bash
curl -i https://api-staging.healthhub4u.co.uk/api/v1/health       # 200 {"status":"live"}
```

To save typing, `printf 'export COMPOSE_FILE=docker-compose.prod.yml\nexport COMPOSE_PROFILES=caddy\n' >> ~/.bashrc`
lets you drop `-f docker-compose.prod.yml --profile caddy` in `~/hajjcare`.

### j. Backups

Daily at 03:15 UTC, keeping the newest 14:

```bash
sudo mkdir -p /var/backups/hajjcare && sudo chown deploy: /var/backups/hajjcare
~/hajjcare/deploy/backup-mongo.sh          # once by hand: prints "backup written: …"
crontab -e
```

Add this line:

```
15 3 * * * /home/deploy/hajjcare/deploy/backup-mongo.sh >> /home/deploy/hajjcare-backup.log 2>&1
```

Test a restore **without touching the live database**, in a throwaway container:

```bash
latest=$(ls -1t /var/backups/hajjcare/hajjcare-*.archive.gz | head -1)
docker run -d --name restore-test mongo:7 && sleep 5
docker exec -i restore-test mongorestore --quiet --archive --gzip < "$latest"
docker exec restore-test mongosh --quiet hajjcare --eval 'db.users.countDocuments()'
docker rm -f restore-test
```

A real restore into the live stack (drops and replaces every collection; asks first):

```bash
~/hajjcare/deploy/restore-mongo.sh /var/backups/hajjcare/hajjcare-<timestamp>.archive.gz
```

These backups live on the same server they protect: if the VPS or its disk is lost, so are
they. **TODO: an off-server copy (another machine or object storage).** Not decided yet. It is
**required before production**, not before staging: staging holds only test accounts.

### k. Updating

```bash
cd ~/hajjcare
~/hajjcare/deploy/backup-mongo.sh
git pull --ff-only
docker compose -f docker-compose.prod.yml --profile caddy up -d --build
docker compose -f docker-compose.prod.yml --profile caddy ps        # sync-indexes Exited (0), api healthy
curl -i https://api-staging.healthhub4u.co.uk/api/v1/health
```

`sync-indexes` runs by itself before the new API starts. The API is down for the few seconds it
takes to restart (one instance, by design). Then, from the laptop, run the contract checker (step n).

### l. Rolling back

```bash
cd ~/hajjcare
git log --oneline -10
git checkout <previous commit>
docker compose -f docker-compose.prod.yml --profile caddy up -d --build
```

`sync-indexes` then applies the older schema's indexes. Data written by the newer version stays.
To go forward again: `git checkout foundation_for_backend && git pull --ff-only`, then `up -d --build`.

### m. Gmail is for staging only

A consumer Gmail account can send roughly 500 messages a day, and Google may pause an account
that sends automated mail at volume. That is plenty for staging and nowhere near enough for Hajj
season. Moving to a transactional provider (with a verified domain, SPF and DKIM — DEPLOY.md §6)
changes only `SMTP_URL` and `EMAIL_FROM` in `.env.production`, followed by
`docker compose -f docker-compose.prod.yml --profile caddy up -d`.

### n. Then run the staging checklist, from the laptop

Work through [DEPLOY-CHECKLIST.md](DEPLOY-CHECKLIST.md). The contract checker runs against the real
host with `OTP_EMAIL` set to the staging Gmail address, so every account it registers is a
`+contract-…` alias of that inbox and the reset email lands there:

```bash
OTP_EMAIL=YOUR_ADDRESS@gmail.com npm run contract -- https://api-staging.healthhub4u.co.uk/api/v1
```

It stops at section 13 and asks for the code emailed to the address it prints; read it from the
inbox and type it in.
