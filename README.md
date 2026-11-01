# Polytype

Requires Node.js 24 or newer. No package installation is needed.

```sh
npm start
```

Open http://127.0.0.1:4173. Use `PORT` and `HOST` to change the listening address.
The server automatically restarts when its JavaScript modules change.
The app must run through this server; a static file server cannot provide the dictionary API.

Words come directly from `data/dictionary.db`, opened with Node's built-in SQLite module.
Each practice round draws up to 100 random words from the selected language, without repeats within the round.
The counter and progress bar track these words rather than the full dictionary.
Restarting, changing languages, or completing the round draws a fresh selection and resets the round's metrics.
Definitions prefer Vietnamese, then English; IPA and parts of speech appear when available.
`languages.json` configures the supported languages and their keyboard layouts.

Practice uses single words of 2–24 characters, with optional apostrophes or hyphens.
Spaces remain the skip shortcut. Japanese practice uses existing Latin-script romaji entries;
no transliteration or sample vocabulary is generated. The original CSV files are no longer used.

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

Set either `POLYTYPE_ADMIN_KEY` or `POLYTYPE_ADMIN_KEY_FILE` on the server before starting it.
The file option reads a plain-text key from the named file at startup, trims surrounding whitespace,
and takes precedence if both variables are set. Without a configured key,
the public app still works, but admin sign-in and dictionary writes stay disabled.
Use a long, randomly generated key stored in your password manager. Restart the server after rotating it;
restarting also clears active admin sessions.

For local Windows use, prompt for the key without placing its value in PowerShell command history:

```powershell
$polytypeKey = Read-Host 'Polytype admin key' -AsSecureString
$env:POLYTYPE_ADMIN_KEY = [System.Net.NetworkCredential]::new('', $polytypeKey).Password
try { npm.cmd start }
finally {
  Remove-Item Env:POLYTYPE_ADMIN_KEY -ErrorAction SilentlyContinue
  $polytypeKey.Dispose()
}
```

Then open http://127.0.0.1:4173/admin/. The browser receives a one-hour session cookie marked
`HttpOnly` and `SameSite=Strict`; the key is not saved in browser storage. Use HTTPS for hosted access
and set `POLYTYPE_ADMIN_SECURE_COOKIE=true` when HTTPS terminates at Nginx or another reverse proxy.
Leave that setting off for local HTTP. See [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
The reverse proxy must preserve the public Host header (Nginx: `proxy_set_header Host $http_host;`)
so the server can verify the origin of admin requests.

Recommended storage options:

- **Local development:** Keep the key in a password manager and use the masked prompt above.
  Environment variables are a convenient runtime fallback, but are not encrypted storage and can appear in diagnostics.
- **A single server:** Keep a read-only secret file outside the repository and web root, with access limited
  to the service account, and point `POLYTYPE_ADMIN_KEY_FILE` at it. A systemd credential can supply this file as shown below.
- **Hosted deployments:** Store the key in the platform's secret manager and mount it or inject it at runtime
  with access limited to the application service. Examples include AWS Secrets Manager and Azure Key Vault.

Keep the key out of source files, Git, URLs, frontend/build variables, logs, and browser storage.
These choices follow [OWASP secrets guidance](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
and [AWS Secrets Manager best practices](https://docs.aws.amazon.com/secretsmanager/latest/userguide/best-practices.html).

## Re-deploy to an SSH server

These steps assume the app is already installed at `/opt/polytype`, runs as the
`polytype` systemd service and user, and is exposed through Nginx. Replace
`SERVER_IP` with your server address. The upload commands use a root SSH login.

1. In local PowerShell, run the checks and upload the current application files
   to a staging directory. Continue only if the checks pass:

   ```powershell
   cd C:\Work\Repos\Polytype
   npm.cmd test
   ssh root@SERVER_IP "mkdir -p /root/polytype-upload"
   scp package.json server.mjs admin-auth.mjs dictionary.mjs index.html app.js admin.js dictionary-editor.js theme.js styles.css languages.json root@SERVER_IP:/root/polytype-upload/
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
   sudo cp /root/polytype-upload/{package.json,server.mjs,admin-auth.mjs,dictionary.mjs,index.html,app.js,admin.js,dictionary-editor.js,theme.js,styles.css,languages.json} /opt/polytype/
   sudo chown root:polytype /opt/polytype/{package.json,server.mjs,admin-auth.mjs,dictionary.mjs,index.html,app.js,admin.js,dictionary-editor.js,theme.js,styles.css,languages.json}
   sudo chmod 640 /opt/polytype/{package.json,server.mjs,admin-auth.mjs,dictionary.mjs,index.html,app.js,admin.js,dictionary-editor.js,theme.js,styles.css,languages.json}
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

   The systemd override allows database writes when the service uses
   `ProtectSystem=strict` from the initial deployment instructions.

4. Provision the admin key before enabling admin sign-in. Keep the raw key in
   `/etc/polytype/admin-key`, owned by root with mode `600`, outside `/opt/polytype`.
   Supply it using your secret-management process; do not put its value in the service unit or shell commands.
   With systemd 247 or newer, add a credential override:

   ```bash
   sudo tee /etc/systemd/system/polytype.service.d/admin.conf > /dev/null <<'EOF'
   [Service]
   LoadCredential=admin-key:/etc/polytype/admin-key
   Environment=POLYTYPE_ADMIN_KEY_FILE=%d/admin-key
   Environment=POLYTYPE_ADMIN_SECURE_COOKIE=true
   EOF
   sudo systemctl daemon-reload
   ```

   systemd makes a private, read-only copy available to the service. The `Secure` cookie setting assumes
   your public Nginx endpoint uses HTTPS. See [systemd credential documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#LoadCredential=ID%5B:PATH%5D).
   If admin access is not needed, skip this override and keep writes disabled.

5. Start the service and verify it:

   ```bash
   sudo systemctl start polytype
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
