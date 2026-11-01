import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const latinWord = /^[\p{Script=Latin}\p{M}]+(?:[-'’][\p{Script=Latin}\p{M}]+)*$/u;
const cyrillicWord = /^[\p{Script=Cyrillic}\p{M}]+(?:[-'’][\p{Script=Cyrillic}\p{M}]+)*$/u;

export class Dictionary {
  constructor(filename, languages) {
    if (!existsSync(filename)) throw new Error('Dictionary database does not exist');
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.function('normalized_lower', { deterministic: true }, (value) => String(value).normalize('NFC').toLowerCase());
    this.languages = languages;
    this.wordLists = new Map();
    this.shuffledWordLists = new Map();
    this.details = this.db.prepare(`
      SELECT w.id, w.word, COALESCE(d.definition, '') AS meaning,
             COALESCE(d.pos, '') AS type,
             COALESCE((SELECT p.ipa FROM pronunciations p
                       WHERE p.word_id = w.id AND trim(p.ipa) <> ''
                       ORDER BY p.id LIMIT 1), '') AS ipa
      FROM words w
      LEFT JOIN definitions d ON d.id = (
        SELECT definition.id FROM word_definitions wd
        JOIN definitions definition ON definition.id = wd.definition_id
        WHERE wd.word_id = w.id
        ORDER BY CASE WHEN trim(definition.definition) = '' THEN 1 ELSE 0 END,
                 CASE definition.definition_lang WHEN 'vi' THEN 0 WHEN 'en' THEN 1 ELSE 2 END,
                 wd.id LIMIT 1
      )
      WHERE w.id = ?
    `);
    this.editDetails = this.db.prepare(`
      SELECT w.id, w.word, w.lang_code AS language,
             d.id AS definitionId, COALESCE(d.definition, '') AS meaning,
             COALESCE(d.pos, '') AS type, COALESCE(d.definition_lang, 'vi') AS definitionLanguage,
             p.id AS pronunciationId, COALESCE(p.ipa, '') AS ipa
      FROM words w
      LEFT JOIN definitions d ON d.id = (
        SELECT definition.id FROM word_definitions wd
        JOIN definitions definition ON definition.id = wd.definition_id
        WHERE wd.word_id = w.id
        ORDER BY CASE WHEN trim(definition.definition) = '' THEN 1 ELSE 0 END,
                 CASE definition.definition_lang WHEN 'vi' THEN 0 WHEN 'en' THEN 1 ELSE 2 END,
                 wd.id LIMIT 1
      )
      LEFT JOIN pronunciations p ON p.id = (
        SELECT id FROM pronunciations WHERE word_id = w.id
        ORDER BY CASE WHEN trim(ipa) = '' THEN 1 ELSE 0 END, id LIMIT 1
      )
      WHERE w.id = ?
    `);
  }

  getDictionaryLanguages() {
    const counts = new Map(this.db.prepare('SELECT lang_code, count(*) AS total FROM words GROUP BY lang_code')
      .all().map((row) => [row.lang_code, row.total]));
    return this.languages.map((language) => ({ ...language, wordCount: counts.get(language.id) || 0 }));
  }

  searchEntries(languageId, query = '', offset = 0, limit = 25) {
    if (!this.languages.some((language) => language.id === languageId)) return null;
    // Match literally, so %, _ and SQL-looking input are ordinary search text.
    const parameters = [languageId, query.normalize('NFC')];
    const where = 'lang_code = ? AND instr(normalized_lower(word), normalized_lower(?)) > 0';
    const { total } = this.db.prepare(`SELECT count(*) AS total FROM words WHERE ${where}`).get(...parameters);
    const rows = this.db.prepare(`SELECT id FROM words WHERE ${where} ORDER BY word COLLATE NOCASE, id LIMIT ? OFFSET ?`)
      .all(...parameters, limit, offset);
    return { language: languageId, query, offset, total, words: rows.map(({ id }) => this.editDetails.get(id)) };
  }

  createEntry(languageId, values) {
    return this.#writeEntry(null, languageId, { ipa: '', type: '', meaning: '', ...values });
  }

  updateEntry(id, values) {
    return this.#writeEntry(id, null, values);
  }

  #writeEntry(id, languageId, values) {
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail(400, 'Dữ liệu từ vựng không hợp lệ.');
    const limits = { word: 200, ipa: 200, type: 100, meaning: 10000 };
    const entry = {};
    for (const [field, limit] of Object.entries(limits)) {
      if (typeof values[field] !== 'string' || values[field].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(values[field])) {
        fail(400, `Trường ${field} không hợp lệ (tối đa ${limit} ký tự).`);
      }
      entry[field] = values[field].trim().normalize('NFC');
    }
    if (!entry.word || /\s/u.test(entry.word.replace(/ /g, ''))) fail(400, 'Từ vựng không được để trống hoặc chứa ký tự xuống dòng.');
    const creating = id === null;
    if (creating && !this.languages.some((language) => language.id === languageId)) fail(400, 'Ngôn ngữ không được hỗ trợ.');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = creating ? {
        language: languageId, meaning: '', type: '', ipa: '', definitionId: null, pronunciationId: null
      } : this.editDetails.get(id);
      if (!current || !this.languages.some((language) => language.id === current.language)) fail(404, 'Không tìm thấy từ vựng.');
      if (this.db.prepare('SELECT id FROM words WHERE lang_code = ? AND word = ? AND id <> ?')
        .get(current.language, entry.word, id ?? 0)) fail(409, 'Từ này đã có trong ngôn ngữ đã chọn.');
      if (creating) {
        const result = this.db.prepare('INSERT INTO words (word, lang_code) VALUES (?, ?)').run(entry.word, current.language);
        id = Number(result.lastInsertRowid);
      } else {
        this.db.prepare('UPDATE words SET word = ? WHERE id = ?').run(entry.word, id);
      }

      if (entry.meaning !== current.meaning || entry.type !== current.type) {
        if (current.definitionId !== null) {
          const shared = this.db.prepare('SELECT 1 FROM word_definitions WHERE definition_id = ? AND word_id <> ? LIMIT 1')
            .get(current.definitionId, id);
          if (shared) {
            // Copy all metadata before changing a definition shared with another word.
            const definition = { ...this.db.prepare('SELECT * FROM definitions WHERE id = ?').get(current.definitionId),
              definition: entry.meaning, pos: entry.type };
            delete definition.id;
            const columns = Object.keys(definition);
            const result = this.db.prepare(`INSERT INTO definitions (${columns.map((column) => `"${column}"`).join(',')})
              VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(definition));
            this.db.prepare('UPDATE word_definitions SET definition_id = ? WHERE word_id = ? AND definition_id = ?')
              .run(result.lastInsertRowid, id, current.definitionId);
          } else {
            this.db.prepare('UPDATE definitions SET definition = ?, pos = ? WHERE id = ?')
              .run(entry.meaning, entry.type, current.definitionId);
          }
        } else if (entry.meaning || entry.type) {
          const result = this.db.prepare('INSERT INTO definitions (definition, pos, definition_lang) VALUES (?, ?, ?)')
            .run(entry.meaning, entry.type, 'vi');
          this.db.prepare('INSERT INTO word_definitions (word_id, definition_id) VALUES (?, ?)').run(id, result.lastInsertRowid);
        }
      }
      if (entry.ipa !== current.ipa) {
        if (current.pronunciationId !== null) {
          this.db.prepare('UPDATE pronunciations SET ipa = ? WHERE id = ?').run(entry.ipa, current.pronunciationId);
        } else if (entry.ipa) {
          this.db.prepare('INSERT INTO pronunciations (word_id, ipa) VALUES (?, ?)').run(id, entry.ipa);
        }
      }
      this.db.exec('COMMIT');
      this.wordLists.delete(current.language);
      this.shuffledWordLists.delete(current.language);
      return this.editDetails.get(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.code?.startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/i.test(error.message)) {
        fail(409, 'Nội dung này trùng với một mục đã có. Vui lòng kiểm tra lại.');
      }
      throw error;
    }
  }

  getWordIds(languageId) {
    if (!this.languages.some((language) => language.id === languageId)) return null;
    if (!this.wordLists.has(languageId)) {
      const pattern = languageId === 'ru' ? cyrillicWord : latinWord;
      const rows = this.db.prepare(`
        SELECT id, word FROM words
        WHERE lang_code = ? AND length(word) BETWEEN 2 AND 24 ORDER BY id
      `).all(languageId);
      // Space is reserved for skipping. Japanese uses the dictionary's romaji entries.
      const ids = rows.filter(({ word }) => pattern.test(word.normalize('NFC'))).map(({ id }) => id);
      this.wordLists.set(languageId, ids);
    }
    return this.wordLists.get(languageId);
  }

  getLanguages() {
    return this.languages.map((language) => ({
      ...language, wordCount: this.getWordIds(language.id).length
    })).filter((language) => language.wordCount > 0);
  }

  getWords(languageId, offset = 0, limit = 100, seed = null) {
    let ids = this.getWordIds(languageId);
    if (!ids) return null;
    if (seed !== null) {
      let shuffled = this.shuffledWordLists.get(languageId);
      if (shuffled?.seed !== seed) {
        const shuffledIds = [...ids];
        let state = seed;
        // Seeded Fisher–Yates keeps subsequent pages in the same random order.
        for (let index = shuffledIds.length - 1; index > 0; index--) {
          state = (state + 0x6d2b79f5) >>> 0;
          let value = Math.imul(state ^ (state >>> 15), state | 1);
          value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
          const random = ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
          const target = Math.floor(random * (index + 1));
          [shuffledIds[index], shuffledIds[target]] = [shuffledIds[target], shuffledIds[index]];
        }
        shuffled = { seed, ids: shuffledIds };
        this.shuffledWordLists.set(languageId, shuffled);
      }
      ids = shuffled.ids;
    }
    return {
      language: languageId,
      offset,
      total: ids.length,
      words: ids.slice(offset, offset + limit).map((id) => {
        const entry = this.details.get(id);
        return { ...entry, word: entry.word.normalize('NFC') };
      })
    };
  }

  close() {
    this.db.close();
  }
}
