(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'langSelect', 'wordDisplayContainer', 'wordIpa', 'wordMeaning', 'wordType',
    'virtualKeyboard', 'wpmDisplay', 'accuracyDisplay', 'countDisplay',
    'layoutBadge', 'currentLayoutName', 'soundToggleBtn', 'soundText',
    'languageLabel', 'sessionStatus', 'progressFill', 'progressLabel',
    'nextWordBtn', 'restartBtn', 'helpDialog', 'helpBtn', 'closeHelpBtn', 'retryBtn', 'practice'
  ].map((id) => [id, byId(id)]));

  const layouts = {
    qwerty: [
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
      ['z', 'x', 'c', 'v', 'b', 'n', 'm'], ['Space']
    ],
    qwertz: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'ß'],
      ['q', 'w', 'e', 'r', 't', 'z', 'u', 'i', 'o', 'p', 'ü'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ö', 'ä'],
      ['y', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.'], ['Space']
    ],
    azerty: [
      ['a', 'z', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['q', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm'],
      ['w', 'x', 'c', 'v', 'b', 'n', 'é', 'è', 'ç', 'à'], ['Space']
    ],
    qwerty_es: [
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ñ'],
      ['z', 'x', 'c', 'v', 'b', 'n', 'm', 'á', 'é', 'í', 'ó', 'ú'], ['Space']
    ],
    jcuken: [
      ['ё', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='],
      ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
      ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
      ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', '.'], ['Space']
    ]
  };

  let languages = [];
  const vocabularyCache = new Map();
  const keyboardKeys = new Map();
  let words = [];
  let wordIndex = 0;
  let wordOffset = 0;
  let wordTotal = 0;
  let pendingOffset = 0;
  let currentLanguageId = '';
  let input = '';
  let totalTyped = 0;
  let correctTyped = 0;
  let startTime = null;
  let soundEnabled = true;
  let audioContext = null;
  let advanceTimer = null;
  let loadVersion = 0;
  let pointerLanguageChange = false;
  let restorePracticeAfterHelp = false;

  function resumeAfterPointer(event) {
    if (event.detail > 0) ui.practice.focus({ preventScroll: true });
  }

  function setStatus(text, state) {
    if (ui.sessionStatus.textContent !== text) ui.sessionStatus.textContent = text;
    ui.sessionStatus.parentElement.dataset.state = state;
  }

  function clearAdvance() {
    window.clearTimeout(advanceTimer);
    advanceTimer = null;
  }

  function playKeySound(isError = false) {
    if (!soundEnabled) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume();
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const duration = isError ? 0.12 : 0.05;
      oscillator.type = isError ? 'sawtooth' : 'triangle';
      oscillator.frequency.setValueAtTime(isError ? 140 : 800, now);
      oscillator.frequency.exponentialRampToValueAtTime(isError ? 70 : 200, now + duration);
      gain.gain.setValueAtTime(isError ? 0.08 : 0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.005, now + duration);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.01);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
    } catch {
      // Typing remains available when browser audio is unavailable.
    }
  }

  function renderKeyboard(layoutKey) {
    const rows = layouts[layoutKey] || layouts.qwerty;
    keyboardKeys.clear();
    ui.virtualKeyboard.replaceChildren();
    const layoutName = layoutKey.toUpperCase().replace('_', ' · ');
    ui.currentLayoutName.textContent = layoutName;
    ui.layoutBadge.textContent = layoutName;
    for (const row of rows) {
      const rowElement = document.createElement('div');
      rowElement.className = 'keyboard-row';
      for (const key of row) {
        const keyElement = document.createElement('div');
        keyElement.className = `keyboard-key${key === 'Space' ? ' keyboard-key--space' : ''}`;
        keyElement.dataset.key = key.toLowerCase();
        keyElement.textContent = key === 'Space' ? 'space' : key;
        keyboardKeys.set(key.toLowerCase(), keyElement);
        rowElement.append(keyElement);
      }
      ui.virtualKeyboard.append(rowElement);
    }
  }

  function updateKeyHint() {
    for (const key of keyboardKeys.values()) key.classList.remove('target-hint');
    const nextCharacter = words[wordIndex]?.word[input.length];
    if (nextCharacter) keyboardKeys.get(nextCharacter.toLowerCase())?.classList.add('target-hint');
  }

  function pressKey(key) {
    const keyElement = keyboardKeys.get(key === ' ' ? 'space' : key.toLowerCase());
    if (!keyElement) return;
    keyElement.classList.add('physical-pressed');
    window.setTimeout(() => keyElement.classList.remove('physical-pressed'), 120);
  }

  function updateMetrics() {
    const elapsedMinutes = startTime === null ? 0 : (performance.now() - startTime) / 60000;
    ui.wpmDisplay.textContent = elapsedMinutes > 0.05
      ? Math.max(0, Math.round(correctTyped / 5 / elapsedMinutes)) : 0;
    ui.accuracyDisplay.textContent = `${totalTyped ? Math.round(correctTyped / totalTyped * 100) : 100}%`;
    const position = wordTotal ? Math.min(wordOffset + wordIndex + 1, wordTotal) : 0;
    ui.countDisplay.textContent = `${position}/${wordTotal}`;
    ui.progressLabel.textContent = wordTotal ? `Từ ${position} trong ${wordTotal}` : 'Chưa có từ vựng';
    ui.progressFill.style.width = `${wordTotal ? position / wordTotal * 100 : 0}%`;
  }

  function resetSession() {
    clearAdvance();
    wordIndex = 0;
    input = '';
    totalTyped = 0;
    correctTyped = 0;
    startTime = null;
    updateMetrics();
  }

  function showMessage(message, status, retry = false) {
    const messageElement = document.createElement('span');
    messageElement.className = 'word-message';
    messageElement.textContent = message;
    ui.wordDisplayContainer.replaceChildren(messageElement);
    ui.wordIpa.textContent = '';
    ui.wordMeaning.textContent = '';
    ui.wordType.textContent = '';
    ui.wordIpa.hidden = true;
    ui.wordMeaning.hidden = true;
    ui.wordType.hidden = true;
    setStatus(status, retry ? 'error' : 'loading');
    ui.retryBtn.hidden = !retry;
    ui.nextWordBtn.disabled = true;
    ui.restartBtn.disabled = true;
    updateKeyHint();
    updateMetrics();
  }

  function displayWord() {
    const current = words[wordIndex];
    if (!current) {
      showMessage('Chưa có từ vựng cho ngôn ngữ này.', 'Không có dữ liệu', true);
      return;
    }
    ui.wordIpa.textContent = current.ipa || '';
    ui.wordMeaning.textContent = current.meaning || '';
    ui.wordType.textContent = current.type || 'từ vựng';
    ui.wordIpa.hidden = !current.ipa;
    ui.wordMeaning.hidden = !current.meaning;
    ui.wordType.hidden = false;
    setStatus(totalTyped ? 'Đang luyện tập' : 'Sẵn sàng luyện tập', totalTyped ? 'active' : 'ready');
    ui.wordDisplayContainer.replaceChildren();
    ui.retryBtn.hidden = true;
    ui.nextWordBtn.disabled = false;
    ui.restartBtn.disabled = false;
    for (let index = 0; index < current.word.length; index++) {
      const character = document.createElement('span');
      let state = 'is-pending';
      if (index < input.length) {
        state = input[index].toLowerCase() === current.word[index].toLowerCase() ? 'is-correct' : 'is-error';
      } else if (index === input.length) state = 'is-current';
      character.className = `word-char ${state}`;
      character.textContent = current.word[index];
      if (state === 'is-current') {
        const caret = document.createElement('span');
        caret.className = 'cursor-caret';
        caret.setAttribute('aria-hidden', 'true');
        character.append(caret);
      }
      ui.wordDisplayContainer.append(character);
    }
    updateKeyHint();
    updateMetrics();
  }

  function nextWord() {
    clearAdvance();
    if (!words.length) return;
    input = '';
    if (wordIndex + 1 < words.length) {
      wordIndex++;
      displayWord();
    } else {
      const offset = wordOffset + words.length;
      loadWordBatch(offset < wordTotal ? offset : 0);
    }
  }

  async function loadWordBatch(offset) {
    const id = currentLanguageId;
    const version = ++loadVersion;
    clearAdvance();
    pendingOffset = offset;
    wordOffset = offset;
    wordIndex = 0;
    input = '';
    words = [];
    ui.wordDisplayContainer.setAttribute('aria-busy', 'true');
    showMessage('Đang chuẩn bị từ vựng…', 'Đang tải từ vựng');
    try {
      let batch = offset === 0 ? vocabularyCache.get(id) : null;
      if (!batch) {
        const query = new URLSearchParams({ language: id, offset: String(offset), limit: '100' });
        const response = await fetch(`/api/words?${query}`, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        batch = await response.json();
        if (!Array.isArray(batch.words) || !batch.words.length ||
            !Number.isSafeInteger(batch.total) || batch.total < batch.words.length ||
            batch.offset !== offset || batch.language !== id) throw new Error('Invalid vocabulary batch');
        if (offset === 0) vocabularyCache.set(id, batch);
      }
      if (version !== loadVersion) return;
      words = batch.words;
      wordOffset = batch.offset;
      wordTotal = batch.total;
      displayWord();
    } catch {
      if (version !== loadVersion) return;
      showMessage('Chưa thể tải từ vựng. Vui lòng thử lại.', 'Kết nối bị gián đoạn', true);
    } finally {
      if (version === loadVersion) ui.wordDisplayContainer.setAttribute('aria-busy', 'false');
    }
  }

  function switchLanguage(id) {
    const language = languages.find((item) => item.id === id);
    if (!language) return;
    currentLanguageId = id;
    wordOffset = 0;
    wordTotal = 0;
    words = [];
    resetSession();
    ui.languageLabel.textContent = language.name;
    renderKeyboard(language.keyboardType || 'qwerty');
    return loadWordBatch(0);
  }

  ui.soundToggleBtn.addEventListener('click', (event) => {
    soundEnabled = !soundEnabled;
    ui.soundToggleBtn.classList.toggle('is-muted', !soundEnabled);
    ui.soundToggleBtn.setAttribute('aria-pressed', String(soundEnabled));
    ui.soundText.textContent = soundEnabled ? 'Âm thanh bật' : 'Âm thanh tắt';
    resumeAfterPointer(event);
  });
  ui.langSelect.addEventListener('pointerdown', () => { pointerLanguageChange = true; });
  ui.langSelect.addEventListener('keydown', () => { pointerLanguageChange = false; });
  ui.langSelect.addEventListener('change', () => {
    const loading = switchLanguage(ui.langSelect.value);
    if (pointerLanguageChange) ui.practice.focus({ preventScroll: true });
    pointerLanguageChange = false;
    return loading;
  });
  ui.nextWordBtn.addEventListener('click', (event) => {
    nextWord();
    resumeAfterPointer(event);
  });
  ui.restartBtn.addEventListener('click', (event) => {
    switchLanguage(ui.langSelect.value);
    resumeAfterPointer(event);
  });
  ui.practice.addEventListener('click', (event) => {
    if (!event.target.closest('button, select, input, textarea, a')) ui.practice.focus({ preventScroll: true });
  });
  ui.helpBtn.addEventListener('click', (event) => {
    restorePracticeAfterHelp = event.detail > 0;
    ui.helpDialog.showModal();
  });
  ui.closeHelpBtn.addEventListener('click', (event) => {
    restorePracticeAfterHelp ||= event.detail > 0;
    ui.helpDialog.close();
  });
  ui.helpDialog.addEventListener('close', () => {
    if (restorePracticeAfterHelp) ui.practice.focus({ preventScroll: true });
    restorePracticeAfterHelp = false;
  });
  ui.helpDialog.addEventListener('click', (event) => {
    if (event.target !== ui.helpDialog) return;
    const bounds = ui.helpDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      restorePracticeAfterHelp = true;
      ui.helpDialog.close();
    }
  });
  ui.retryBtn.addEventListener('click', (event) => {
    const loading = languages.length ? loadWordBatch(pendingOffset) : init();
    resumeAfterPointer(event);
    return loading;
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && ui.helpDialog.open) {
      ui.helpDialog.close();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || ui.helpDialog.open) return;
    if (event.target instanceof Element && event.target.closest('button, select, input, textarea, a, [contenteditable="true"], dialog')) return;
    if (event.key === 'Tab' || !words.length) return;
    if (event.key === ' ') {
      event.preventDefault();
      pressKey(' ');
      playKeySound();
      nextWord();
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      clearAdvance();
      input = input.slice(0, -1);
      playKeySound();
      displayWord();
      return;
    }
    if (event.key.length !== 1 || advanceTimer !== null) return;
    event.preventDefault();
    startTime ??= performance.now();
    pressKey(event.key);
    const expected = words[wordIndex].word[input.length];
    const isCorrect = expected && event.key.toLowerCase() === expected.toLowerCase();
    totalTyped++;
    if (isCorrect) correctTyped++;
    input += event.key;
    playKeySound(!isCorrect);
    displayWord();
    if (input.toLowerCase() === words[wordIndex].word.toLowerCase()) advanceTimer = window.setTimeout(nextWord, 180);
  });

  async function init() {
    ui.langSelect.disabled = true;
    ui.wordDisplayContainer.setAttribute('aria-busy', 'true');
    showMessage('Đang chuẩn bị không gian luyện tập…', 'Đang tải');
    try {
      const response = await fetch('/api/languages', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      languages = (data.languages || []).filter((item) => item.id && item.name && item.wordCount > 0);
      if (!languages.length) throw new Error('No languages');
      ui.langSelect.replaceChildren();
      for (const language of languages) {
        const option = document.createElement('option');
        option.value = language.id;
        option.textContent = language.name;
        ui.langSelect.append(option);
      }
      ui.langSelect.disabled = false;
      await switchLanguage(languages[0].id);
    } catch {
      ui.wordDisplayContainer.setAttribute('aria-busy', 'false');
      showMessage('Chưa thể tải ngôn ngữ. Vui lòng thử lại.', 'Kết nối bị gián đoạn', true);
    }
  }

  renderKeyboard('qwerty');
  init();
})();
