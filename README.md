# Polytype

Requires Node.js 24 or newer. No package installation is needed.

```sh
npm start
```

Open http://127.0.0.1:4173. Use `PORT` and `HOST` to change the listening address.
The app must run through this server; a static file server cannot provide the dictionary API.

Words come directly from `data/dictionary.db`, opened read-only with Node's built-in SQLite module.
The browser requests at most 100 entries at a time and moves through subsequent batches as you practice.
Definitions prefer Vietnamese, then English; IPA and parts of speech appear when available.
`languages.json` configures the supported languages and their keyboard layouts.

Practice uses single words of 2–24 characters, with optional apostrophes or hyphens.
Spaces remain the skip shortcut. Japanese practice uses existing Latin-script romaji entries;
no transliteration or sample vocabulary is generated. The original CSV files are no longer used.

Run checks with `npm test`.
