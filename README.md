# Dilemma

A minimal voting app: users open the site on their phone and see a split screen with
a **1** button and a **2** button. The admin screen at `/admin` shows the live tally.

- Vote page: `https://<ip-with-dashes>.sslip.io/`
- Admin page: `https://<ip-with-dashes>.sslip.io/admin` (user `admin`, password = `ADMIN_PASSWORD` secret)

Each phone gets an anonymous cookie, so one device = one vote (it can change its vote).

## Layout

| Path | What |
|---|---|
| `app/` | Node.js server (no dependencies) + static pages |
| `deploy/setup.sh` | Idempotent server install: Node, Caddy (HTTPS), firewall, systemd |
| `infra/provision.sh` | One-time creation of the Always Free VM on Oracle Cloud via OCI CLI |
| `.github/workflows/deploy.yml` | On every push to `main`: upload app to the VM and run `setup.sh` |

## Run locally

```bash
ADMIN_PASSWORD=secret node app/server.js   # http://127.0.0.1:3000
```

## Infrastructure (Oracle Cloud, Always Free only)

`infra/provision.sh` creates a VCN, internet gateway, public subnet (ports 22/80/443) and one
VM, trying `VM.Standard.A1.Flex` (ARM, 2 OCPU / 12 GB) first and falling back to
`VM.Standard.E2.1.Micro`. Both are in the Always Free tier. It is safe to re-run.

```bash
SSH_PUBLIC_KEY=~/.ssh/dilemma_oci.pub bash infra/provision.sh
```

## GitHub secrets used by the deploy workflow

| Secret | Value |
|---|---|
| `OCI_HOST` | Public IP of the VM |
| `OCI_SSH_PRIVATE_KEY` | Private SSH key matching the key installed on the VM |
| `ADMIN_PASSWORD` | Password for `/admin` |

Repository variable (optional): `CUSTOM_DOMAIN` — e.g. `dilemma.yonatankatz.com`. Needs a DNS
`A` record pointing at `OCI_HOST`; Caddy then issues a Let's Encrypt certificate for it automatically.
