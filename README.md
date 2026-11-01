# Polytype

Requires Node.js 24 or newer. No package installation is needed.
For local public-app development:

```sh
npm start
```

Open http://127.0.0.1:4173. Use `PORT` and `HOST` to change the listening address.
The development server automatically restarts when its JavaScript modules change.
The app must run through this server; a static file server cannot provide the dictionary API.

Words come directly from `data/dictionary.db`, opened with Node's built-in SQLite module.
Each practice round draws up to 100 random words from the selected language, without repeats within the round.
The counter and progress bar track these words rather than the full dictionary.
Restarting, changing languages, or completing the round draws a fresh selection and resets the round's metrics.
Definitions prefer Vietnamese, then English; IPA and parts of speech appear when available.
`languages.json` configures the supported languages and their keyboard layouts.

Practice uses single words of 2–24 characters, with optional apostrophes or hyphens.
Spaces remain the skip shortcut. Japanese practice uses existing Latin-script romaji entries;
no transliteration or sample vocabulary is generated.

Open the **Từ điển** tab to browse all dictionary entries by language, search for a word,
and view its spelling, displayed IPA, part of speech, and preferred definition under **Word detail**.
The public app is read-only. Open **`/admin/`** to enter the admin key in the sign-in popup;
only authenticated admins can see or use the add/edit controls. The server also protects both write APIs.
In the admin version, choose **Lưu thay đổi** to save directly to SQLite, or **Thêm từ mới**
to create an entry in the selected language, then **Thêm từ** to save it.
Practice reloads with the updated vocabulary after a save.
Only the word is required; IPA, part of speech, and a Vietnamese meaning are optional.
Duplicate words in the same language are rejected. New entries follow the same practice eligibility rules.
Other definitions and pronunciations are preserved, and shared definitions are copied before editing.
The editor warns before discarding unsaved changes. The database file must be writable.

Run checks with `npm test`.

## Admin key setup

Store `POLYTYPE_ADMIN_KEY` only in **OpenBao Secure Secret Storage**, using KV v2
at `secret/polytype/admin`. Follow the [step-by-step Linux guide](docs/openbao-linux.md)
for installation, TLS, policies, application authentication, rotation, and reboot recovery.

The server fetches the key directly from OpenBao over verified HTTPS at startup,
keeps its sign-in hash in memory, and revokes its OpenBao token after the read.
OpenBao is the key's only persistent store.

The public runtime settings are `POLYTYPE_OPENBAO_ADDR`, `POLYTYPE_OPENBAO_ROLE_ID`,
`POLYTYPE_OPENBAO_CA_FILE` (a public CA certificate), and optionally
`POLYTYPE_OPENBAO_KV_PATH` and `POLYTYPE_OPENBAO_TIMEOUT_MS`. Each start also needs
an in-memory `POLYTYPE_OPENBAO_SECRET_ID`, issued for one AppRole login. The client
removes this bootstrap credential from its environment before making requests.

Without OpenBao configuration, the public app works and admin writes remain
disabled. Partial configuration or any OpenBao read/authentication failure stops
startup. Restart after rotating the key; restarting also clears admin sessions.
A new one-use credential is required for each start, so the supplied Linux service
uses manual activation instead of automatic restarts.

Open `/admin/` and enter the key retrieved on demand from OpenBao. The browser
receives a one-hour session cookie marked `HttpOnly` and `SameSite=Strict`; it does
not save the key in browser storage. Use HTTPS for hosted access and set
`POLYTYPE_ADMIN_SECURE_COOKIE=true` when HTTPS terminates at a reverse proxy.
The proxy must preserve the public Host header (Nginx:
`proxy_set_header Host $http_host;`) for admin-origin validation.

## Re-deploy to an SSH server

These steps assume the app is already installed at `/opt/polytype`, runs as the
`polytype` systemd service and user, and is exposed through Nginx. Replace
`SERVER_IP` with your server address. The upload commands use a root SSH login.

1. In local PowerShell, run the checks and upload the current application files
   to a staging directory. Continue only if the checks pass:

   ```powershell
   cd C:\Work\Repos\Polytype
   npm.cmd test
   ssh root@SERVER_IP "mkdir -p /root/polytype"
   scp package.json server.mjs openbao.mjs admin-auth.mjs dictionary.mjs index.html app.js admin.js dictionary-editor.js theme.js styles.css languages.json root@SERVER_IP:/root/polytype/
   scp -r deploy/openbao root@SERVER_IP:/root/polytype/
   ssh root@SERVER_IP
   ```

2. On the server, stop the app, back up the existing installation (including the
   database), and copy the new files:

   ```bash
   sudo systemctl stop polytype
   BACKUP_DIR="/opt/polytype-backup-$(date +%Y%m%d-%H%M%S)"
   sudo cp -a /opt/polytype "$BACKUP_DIR"
   echo "Backup: $BACKUP_DIR"
   ```

   Continue only if the backup succeeds:

   ```bash
   sudo cp /root/polytype/{package.json,server.mjs,openbao.mjs,admin-auth.mjs,dictionary.mjs,index.html,app.js,admin.js,dictionary-editor.js,theme.js,styles.css,languages.json} /opt/polytype/
   sudo chown root:polytype /opt/polytype/{package.json,server.mjs,openbao.mjs,admin-auth.mjs,dictionary.mjs,index.html,app.js,admin.js,dictionary-editor.js,theme.js,styles.css,languages.json}
   sudo chmod 640 /opt/polytype/{package.json,server.mjs,openbao.mjs,admin-auth.mjs,dictionary.mjs,index.html,app.js,admin.js,dictionary-editor.js,theme.js,styles.css,languages.json}
   ```

   Keep the server's `data/dictionary.db`: it contains edits made through the app
   and is excluded from Git. Routine re-deployments do not replace it.

3. Ensure the dictionary editor can write to SQLite and create its journal files:

   ```bash
   sudo chown -R polytype:polytype /opt/polytype/data
   sudo chmod 750 /opt/polytype/data
   sudo chmod 640 /opt/polytype/data/dictionary.db
   sudo mkdir -p /etc/systemd/system/polytype.service.d
   sudo tee /etc/systemd/system/polytype.service.d/data.conf > /dev/null <<'EOF'
   [Service]
   ReadWritePaths=/opt/polytype/data
   EOF
   sudo systemctl daemon-reload
   ```

   This allows SQLite writes when the service uses `ProtectSystem=strict`.

4. Configure OpenBao using the [Linux implementation guide](docs/openbao-linux.md).
   Store the admin key only in KV v2; provision public connection settings and
   supply a fresh one-use AppRole SecretID in memory when starting the app.

5. Start the service and verify it:

   ```bash
   # Run the start_polytype function from the OpenBao guide with an operator login.
   start_polytype
   sudo systemctl status polytype --no-pager
   curl -f http://127.0.0.1:4173/api/languages
   ```

   Open your public domain and check practice and the read-only Word detail view.
   Then open `/admin/`, sign in, and check that add/edit controls appear. Refresh
   with **Ctrl+Shift+R** to load the updated browser assets. Nginx does not need a
   reload unless its configuration changed. No `npm install` or build is needed.

   If startup fails, inspect the logs:

   ```bash
   sudo journalctl -u polytype -n 100 --no-pager
   ```

## Dictionary data credit

Dictionary data is provided by **@minhqnd** at [dict.minhqnd.com](https://dict.minhqnd.com/),
from the [minhqnd/dictionary SQLite release](https://github.com/minhqnd/dictionary/releases/tag/v2.0.0),
under [Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).

Polytype filters entries for practice and supports local edits to words, IPA, parts of speech,
and definitions. When redistributing modified dictionary data, indicate your changes, retain
the attribution, and share the modified data under CC BY-SA 4.0.
See [data/README.md](data/README.md) for the data sources and license notice.
