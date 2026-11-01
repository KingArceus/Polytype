# OpenBao on Linux

`POLYTYPE_ADMIN_KEY` lives only in OpenBao KV v2 at `secret/polytype/admin`.
On startup, Polytype authenticates over verified HTTPS, reads the key into memory,
keeps its sign-in hash, and revokes the OpenBao token. Each start requires a fresh,
single-use AppRole SecretID supplied in memory. No key or credential file is created.

Requires Ubuntu 24.04/Debian 12, systemd 252+, cgroup v2, Node.js 24+ at
`/usr/bin/node`, and an existing `polytype.service` running as `polytype` from
`/opt/polytype` behind HTTPS. Deploy the app using the [README](../README.md#re-deploy-to-an-ssh-server),
including `openbao.mjs`, and upload `deploy/openbao/` to `/root/polytype/openbao/`.
Run the following in root Bash with terminal recording off.

## 0. Install OpenBao

First try `/usr/local/bin/bao version`. If it works, add `/usr/local/bin` to `PATH`
and skip the download. Otherwise install the verified 2.7.2 release below.
These are installation commands only; they do not initialize or replace storage.

```bash
export PATH="/usr/local/bin:$PATH"
apt-get update
apt-get install -y ca-certificates curl gnupg tar openssl
(
  set -euo pipefail
  BAO_VERSION=2.7.2
  case "$(uname -m)" in
    x86_64) BAO_ARCH=amd64 ;;
    aarch64|arm64) BAO_ARCH=arm64 ;;
    *) echo 'Unsupported architecture' >&2; exit 1 ;;
  esac
  BAO_DOWNLOAD_DIR=$(mktemp -d)
  cd "$BAO_DOWNLOAD_DIR"
  BAO_ARCHIVE="openbao_${BAO_VERSION}_linux_${BAO_ARCH}.tar.gz"
  BAO_RELEASE="https://github.com/openbao/openbao/releases/download/v${BAO_VERSION}"
  curl -fLO "$BAO_RELEASE/$BAO_ARCHIVE"
  curl -fLO "$BAO_RELEASE/checksums.txt"
  curl -fLO "$BAO_RELEASE/checksums.txt.gpgsig"
  curl -fL https://openbao.org/assets/openbao-gpg-pub-20240618.asc -o signing-key.asc
  mkdir -m 700 gnupg
  BAO_SIGNER=$(gpg --homedir "$BAO_DOWNLOAD_DIR/gnupg" --show-keys --with-colons signing-key.asc |
    awk -F: '$1 == "fpr" {print $10; exit}')
  test "$BAO_SIGNER" = 66D15FDD87287219C8E15478D200CD702853E6D0
  gpg --homedir "$BAO_DOWNLOAD_DIR/gnupg" --import signing-key.asc
  gpg --homedir "$BAO_DOWNLOAD_DIR/gnupg" --verify checksums.txt.gpgsig checksums.txt
  awk -v file="$BAO_ARCHIVE" '$2 == file {print}' checksums.txt > selected.sha256
  test -s selected.sha256
  sha256sum --check selected.sha256
  tar -xzf "$BAO_ARCHIVE" bao
  install -o root -g root -m 0755 bao /usr/local/bin/bao
)
hash -r
bao version
```

Continue only if installation succeeds and the version is shown. See
[OpenBao installation and signature verification](https://openbao.org/docs/install/).

## 1. Configure OpenBao

Upload the configuration directory from local PowerShell, replacing `SERVER_IP`:

```powershell
cd C:\Work\Repos\Polytype
ssh root@SERVER_IP "mkdir -p /root/polytype"
scp -r deploy/openbao root@SERVER_IP:/root/polytype/
ssh root@SERVER_IP
```

Before enabling `set -e`, confirm the uploaded files exist:

```bash
ls -l /root/polytype/openbao/{server.hcl,openbao.service,polytype-admin-read.hcl,polytype-operator.hcl,polytype-openbao.conf}
```

Continue only if all five files are listed. Run setup blocks in a fresh root shell;
their subshells stop on errors without enabling `set -e` for the SSH session.

```bash
set +x
umask 077
(
set -euo pipefail
getent passwd openbao >/dev/null ||
  useradd --system --user-group --home-dir /var/lib/openbao --shell /usr/sbin/nologin openbao
install -d -o root -g openbao -m 0750 /etc/openbao /etc/openbao/tls
install -d -o openbao -g openbao -m 0700 /var/lib/openbao/raft /var/log/openbao
install -d -o root -g polytype -m 0750 /etc/polytype /etc/polytype/openbao
)
```

Create the local TLS certificate once, or provide an existing certificate with
`127.0.0.1` in its SAN. Renew before expiry and update the app's public CA copy.
OpenBao's TLS identity and recovery shares are separate bootstrap material.

```bash
(
set -euo pipefail
if [ ! -e /etc/openbao/tls/server.key ] && [ ! -e /etc/openbao/tls/server.crt ]; then
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -subj '/CN=localhost' -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
  -keyout /etc/openbao/tls/server.key -out /etc/openbao/tls/server.crt
else
  test -s /etc/openbao/tls/server.key
  test -s /etc/openbao/tls/server.crt
fi
chown root:openbao /etc/openbao/tls/server.{key,crt}
chmod 0640 /etc/openbao/tls/server.{key,crt}
install -o root -g polytype -m 0640 /etc/openbao/tls/server.crt /etc/polytype/openbao/ca.crt
install -o root -g openbao -m 0640 /root/polytype/openbao/server.hcl /etc/openbao/server.hcl
install -m 0644 /root/polytype/openbao/openbao.service /etc/systemd/system/openbao.service
bao operator validate-config -config=/etc/openbao/server.hcl
systemctl daemon-reload
systemctl enable --now openbao
)
```

Continue only if setup succeeded. Confirm the API responds before initialization:

```bash
export BAO_ADDR=https://127.0.0.1:8200
export BAO_CACERT=/etc/polytype/openbao/ca.crt
curl --cacert "$BAO_CACERT" --retry 10 --retry-connrefused --retry-delay 1 \
  -fsS "$BAO_ADDR/v1/sys/seal-status"
bao status
```

If `Initialized` is `false`, initialize once:

```bash
bao operator init -key-shares=5 -key-threshold=3
```

If `Sealed` is `true`, submit three different unseal shares at the hidden prompts:

```bash
bao operator unseal
bao operator unseal
bao operator unseal
bao status
```

Entrust recovery shares to custodians. Continue to step 2 only after `bao status`
reports `Initialized: true` and `Sealed: false`. The supplied config uses
Raft, loopback-only ports 8200/8201, and a HMAC-protected file audit device.
Keep audit `log_raw` disabled and maintain log rotation/disk space.

## 2. Store the key and configure AppRole

Disable tracing and clear the rejected token:

```bash
set +x
unset BAO_TOKEN
```

Run this command **by itself**, then paste the `Initial Root Token` from
`bao operator init` at the hidden prompt and press Enter. Do not paste subsequent
commands together with the prompt. Unseal shares and the Polytype admin key are
different credentials.

```bash
BAO_TOKEN=$(bao login -no-store -field=token) && export BAO_TOKEN && bao token lookup -field=policies
```

The command captures the token in memory without a token-helper file, then checks
only its policies. Continue only if they include `root`. A 403 means the token is missing,
invalid, revoked, or lacks access. Re-enter the original initialization token;
do not reinitialize storage. Reuse existing KV v2 and AppRole mounts if enabled.

```bash
bao audit list
bao secrets enable -path=secret kv-v2
bao kv metadata put -mount=secret -max-versions=5 polytype/admin
openssl rand -hex 32 | tr -d '\n' |
  bao kv put -mount=secret -cas=0 polytype/admin POLYTYPE_ADMIN_KEY=-
bao policy write polytype-admin-read /root/polytype/openbao/polytype-admin-read.hcl
bao auth enable approle
bao write auth/approle/role/polytype \
  token_policies=polytype-admin-read token_ttl=1m token_max_ttl=1m token_num_uses=0 \
  secret_id_ttl=10m secret_id_num_uses=1 \
  secret_id_bound_cidrs=127.0.0.1/32 token_bound_cidrs=127.0.0.1/32
```

The key goes directly from stdin into OpenBao. The app policy grants only `read`
on `secret/data/polytype/admin`; the standard `default` policy allows token
self-revocation. SecretIDs permit one login within ten minutes; tokens expire
within one minute and are revoked immediately after the read.

## 3. Configure Polytype

`app.env` contains only public settings. The RoleID alone cannot authenticate.
The default KV API path and request timeout are shown explicitly below.

```bash
POLYTYPE_ROLE_ID=$(bao read -field=role_id auth/approle/role/polytype/role-id)
printf '%s\n' \
  'POLYTYPE_OPENBAO_ADDR=https://127.0.0.1:8200' \
  'POLYTYPE_OPENBAO_CA_FILE=/etc/polytype/openbao/ca.crt' \
  "POLYTYPE_OPENBAO_ROLE_ID=$POLYTYPE_ROLE_ID" \
  'POLYTYPE_OPENBAO_KV_PATH=secret/data/polytype/admin' \
  'POLYTYPE_OPENBAO_TIMEOUT_MS=5000' > /etc/polytype/openbao/app.env
unset POLYTYPE_ROLE_ID
chown root:polytype /etc/polytype/openbao/app.env
chmod 0640 /etc/polytype/openbao/app.env
systemctl stop polytype
install -d -m 0755 /etc/systemd/system/polytype.service.d
install -m 0644 /root/polytype/openbao/polytype-openbao.conf \
  /etc/systemd/system/polytype.service.d/zz-openbao.conf
systemctl daemon-reload
systemctl disable polytype
```

Check the drop-in's Node path and retain `ReadWritePaths=/opt/polytype/data` for
SQLite. It resets credentials, pre-start commands, and runtime directories;
restore unrelated assignments if your service needs them. Both supplied services
disable core dumps and swap via `LimitCORE=0` and `MemorySwapMax=0`.

## 4. Create the operator login

The operator can read/rotate the key and issue SecretIDs. Reuse an existing
userpass mount when applicable. Verify the two capability checks before revoking
the root token: expect `create, read, update` and `list, update`, respectively.

```bash
bao policy write polytype-operator /root/polytype/openbao/polytype-operator.hcl
bao auth enable userpass
```

Run the password prompt alone, enter the password, then continue with the next block:

```bash
read -r -s -p 'Operator password: ' POLYTYPE_OPERATOR_PASSWORD </dev/tty
```

```bash
printf '\n'
test -n "$POLYTYPE_OPERATOR_PASSWORD"
printf '%s' "$POLYTYPE_OPERATOR_PASSWORD" |
  bao write auth/userpass/users/polytype-operator password=- policies=polytype-operator
unset POLYTYPE_OPERATOR_PASSWORD
POLYTYPE_OPERATOR_TOKEN=$(bao login -method=userpass -no-store -token-only username=polytype-operator)
BAO_TOKEN="$POLYTYPE_OPERATOR_TOKEN" bao token capabilities secret/data/polytype/admin
BAO_TOKEN="$POLYTYPE_OPERATOR_TOKEN" bao token capabilities auth/approle/role/polytype/secret-id
bao token revoke -self
export BAO_TOKEN="$POLYTYPE_OPERATOR_TOKEN"
unset POLYTYPE_OPERATOR_TOKEN
```

## 5. Start or restart Polytype

Define this function in the operator's root Bash session. It supplies a SecretID
through systemd's memory, clears the manager variable after activation, and waits
up to 30 checks for admin authentication to be configured. Startup failures show
the service status and recent logs. The client removes the SecretID from its
environment before making requests.

```bash
start_polytype() (
  set +x
  set -u
  trap 'systemctl unset-environment POLYTYPE_OPENBAO_SECRET_ID >/dev/null 2>&1 || true' EXIT
  if [ -z "${BAO_TOKEN:-}" ]; then
    printf 'Authenticate as the OpenBao operator and export BAO_TOKEN first.\n' >&2
    exit 1
  fi
  if ! POLYTYPE_OPENBAO_SECRET_ID=$(bao write -f -field=secret_id auth/approle/role/polytype/secret-id); then
    printf 'Unable to issue a SecretID; check OpenBao authentication and permissions.\n' >&2
    exit 1
  fi
  if [ -z "$POLYTYPE_OPENBAO_SECRET_ID" ]; then
    printf 'OpenBao returned an empty SecretID.\n' >&2
    exit 1
  fi
  export POLYTYPE_OPENBAO_SECRET_ID
  systemctl import-environment POLYTYPE_OPENBAO_SECRET_ID || exit 1
  if systemctl reset-failed polytype && systemctl restart polytype; then
    systemctl unset-environment POLYTYPE_OPENBAO_SECRET_ID || exit 1
    unset POLYTYPE_OPENBAO_SECRET_ID
    for attempt in {1..30}; do
      systemctl is-active --quiet polytype || break
      if response=$(curl -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:4173/api/admin/session 2>/dev/null) && [[ "$response" == *'"configured":true'* ]]; then
        printf '%s\n' "$response"
        exit 0
      fi
      sleep 1
    done
  fi
  printf 'Polytype did not become ready. Service diagnostics:\n' >&2
  systemctl status polytype --no-pager -l || true
  journalctl -u polytype -n 60 --no-pager || true
  exit 1
)
start_polytype
```

Paste the entire block, including the final `start_polytype` line. It prints
`{"authenticated":false,"configured":true}` on success and returns nonzero on
failure. The check assumes the default address `127.0.0.1:4173`; adjust the URL
if your service uses another host or port. A failed start needs a fresh SecretID.
Automatic restarts and boot activation are disabled. After reboot,
unseal OpenBao, then authenticate as the operator and redefine/run the function:

```bash
set +x
export BAO_ADDR=https://127.0.0.1:8200
export BAO_CACERT=/etc/polytype/openbao/ca.crt
BAO_TOKEN=$(bao login -method=userpass -no-store -token-only username=polytype-operator)
export BAO_TOKEN
```

## 6. Sign in and rotate

```bash
bao kv get -mount=secret -field=POLYTYPE_ADMIN_KEY polytype/admin
```

The command displays the key: do not save it in files, logs, clipboard history,
password managers, or browser storage. The browser retains only a session cookie.

To rotate, inspect metadata, substitute its numeric version for `CURRENT_VERSION`,
and restart to load the new key and clear sessions:

```bash
bao kv metadata get -mount=secret polytype/admin
openssl rand -hex 32 | tr -d '\n' |
  bao kv put -mount=secret -cas=CURRENT_VERSION polytype/admin POLYTYPE_ADMIN_KEY=-
start_polytype
bao token revoke -self
unset BAO_TOKEN
```

Revoke the operator token when finished even if no rotation was needed.

## Checks

```bash
systemctl status openbao polytype --no-pager
journalctl -u openbao -u polytype -n 100 --no-pager
BAO_TEST_BINARY=/usr/local/bin/bao npm test  # Run from the repository.
```

Login HTTP 400/403: issue a new SecretID and check role/CIDRs. HTTP 503: unseal.
TLS errors: check SANs, expiry, and CA trust. Read errors: check the KV `/data/`
path, policy, and non-empty string field (maximum 4096 characters, no surrounding
whitespace). Configured OpenBao failures stop startup; no configuration leaves
admin writes disabled. A running app retains its hash until restart.
