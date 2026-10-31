import { DatabaseSync } from 'node:sqlite';

const latinWord = /^[\p{Script=Latin}\p{M}]+(?:[-'’][\p{Script=Latin}\p{M}]+)*$/u;
const cyrillicWord = /^[\p{Script=Cyrillic}\p{M}]+(?:[-'’][\p{Script=Cyrillic}\p{M}]+)*$/u;

export class Dictionary {
  constructor(filename, languages) {
    this.db = new DatabaseSync(filename, { readOnly: true });
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
        WHERE wd.word_id = w.id AND trim(definition.definition) <> ''
        ORDER BY CASE definition.definition_lang WHEN 'vi' THEN 0 WHEN 'en' THEN 1 ELSE 2 END,
                 wd.id LIMIT 1
      )
      WHERE w.id = ?
    `);
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
