# VPS runbook — HajjCare API on one Ubuntu server

One Ubuntu VPS running Docker Compose with three long-running services: MongoDB 7 (one-node
replica set, never published), the API, and Caddy (HTTPS with automatic Let's Encrypt
certificates, the only thing on ports 80/443). Files: `docker-compose.prod.yml`,
`deploy/Caddyfile`, `.env.production.example`, `deploy/backup-mongo.sh`, `deploy/restore-mongo.sh`.
Background and every variable: [DEPLOY.md](DEPLOY.md).

Placeholders: `api.<domain>` is the API hostname, `<vps-ip>` the server's address, `deploy` the
login user. Commands marked *laptop* run on your machine; everything else on the VPS.

## a. Requirements

- Ubuntu **22.04 or 24.04**, a public IPv4 address.
- **2 GB RAM or more** recommended. 1 GB works only with swap (below).
- A domain with an **A record `api.<domain>` → `<vps-ip>`**. If there is an AAAA record for that
  name it must point at this server too, or certificate issuance fails. Check from the laptop:
  `dig +short api.<domain>`.

With 1 GB of RAM, add 2 GB of swap first:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## b. Check outbound SMTP FIRST

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

## c. A sudo user with SSH keys; no passwords, no root login

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

## d. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw enable
sudo ufw status verbose
```

Note: Docker's published ports **bypass UFW**, so the firewall is not what keeps MongoDB private.
What does is that only Caddy publishes ports in `docker-compose.prod.yml` (80, 443). Never add a
`ports:` entry to `mongo` or `api`.

## e. Docker Engine and the compose plugin (Docker's official apt repository)

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

## f. Get the code with a read-only deploy key

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

## g. `.env.production`

```bash
cd ~/hajjcare
cp .env.production.example .env.production
chmod 600 .env.production
for key in JWT_ACCESS_SECRET OTP_HMAC_SECRET RC_WEBHOOK_SECRET; do
  sed -i "s|^$key=.*|$key=$(openssl rand -base64 48)|" .env.production
done
nano .env.production
```

In the editor set `API_DOMAIN=api.<domain>`, and `SMTP_URL` and `EMAIL_FROM` from step h. The
API refuses to start while any secret is still `CHANGE_ME`. Keep a copy of this file somewhere
safe off the server (a password manager): the secrets cannot be recovered from the database.

## h. Gmail App Password (staging email)

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

## i. First start

```bash
cd ~/hajjcare
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

Expect `mongo`, `api` (healthy) and `caddy` Up, and `rs-init` and `sync-indexes` **Exited (0)**.
Only `caddy` shows published ports. Watch the logs (Ctrl+C stops watching, not the services):

```bash
docker compose -f docker-compose.prod.yml logs -f api caddy
```

Caddy gets the certificate within a minute of the first request to the name. Then, from the
laptop:

```bash
curl -i https://api.<domain>/api/v1/health       # 200 {"status":"live"}
```

To save typing, `echo 'export COMPOSE_FILE=docker-compose.prod.yml' >> ~/.bashrc` lets you drop the
`-f docker-compose.prod.yml` in `~/hajjcare` (the backup scripts set it themselves).

## j. Backups

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

These backups live on the same server they protect. TODO: copy them off the server (another
machine or object storage); not decided yet.

## k. Updating

```bash
cd ~/hajjcare
~/hajjcare/deploy/backup-mongo.sh
git pull --ff-only
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps        # sync-indexes Exited (0), api healthy
curl -i https://api.<domain>/api/v1/health
```

`sync-indexes` runs by itself before the new API starts. The API is down for the few seconds it
takes to restart (one instance, by design). Then, from the laptop, run the contract checker (step n).

## l. Rolling back

```bash
cd ~/hajjcare
git log --oneline -10
git checkout <previous commit>
docker compose -f docker-compose.prod.yml up -d --build
```

`sync-indexes` then applies the older schema's indexes. Data written by the newer version stays.
To go forward again: `git checkout foundation_for_backend && git pull --ff-only`, then `up -d --build`.

## m. Gmail is for staging only

A consumer Gmail account can send roughly 500 messages a day, and Google may pause an account
that sends automated mail at volume. That is plenty for staging and nowhere near enough for Hajj
season. Moving to a transactional provider (with a verified domain, SPF and DKIM — DEPLOY.md §6)
changes only `SMTP_URL` and `EMAIL_FROM` in `.env.production`, followed by
`docker compose -f docker-compose.prod.yml up -d`.

## n. Then run the staging checklist, from the laptop

Work through [DEPLOY-CHECKLIST.md](DEPLOY-CHECKLIST.md). The contract checker runs against the real
host with `OTP_EMAIL` set to the staging Gmail address, so every account it registers is a
`+contract-…` alias of that inbox and the reset email lands there:

```bash
OTP_EMAIL=YOUR_ADDRESS@gmail.com npm run contract -- https://api.<domain>/api/v1
```

It stops at section 13 and asks for the code emailed to the address it prints; read it from the
inbox and type it in.
