(() => {
  'use strict';

  const PAGE_SIZE = 25;
  const fields = ['word', 'ipa', 'type', 'meaning'];
  const ui = Object.fromEntries([
    'practicePage', 'practiceTab', 'dictionaryTab', 'keyboardTab', 'dictionary',
    'dictionaryHeading', 'currentPageLabel', 'dictionarySearchForm', 'dictionaryLanguage',
    'dictionarySearch', 'dictionarySearchBtn', 'dictionaryCount', 'dictionaryStatus',
    'dictionaryRetryBtn', 'dictionaryList', 'dictionaryPrevBtn', 'dictionaryNextBtn',
    'dictionaryPageLabel', 'dictionaryEmpty', 'dictionaryEditForm', 'dictionaryDirty',
    'dictionarySaveStatus', 'dictionarySaveBtn', 'dictionaryCancelBtn', 'editMeaningLanguage',
    'editWord', 'editIpa', 'editType', 'editMeaning', 'dictionaryAddBtn', 'dictionaryEditHeading', 'dictionaryHint',
    'dictionaryFormActions'
  ].map((id) => [id, document.getElementById(id)]));
  const inputs = { word: ui.editWord, ipa: ui.editIpa, type: ui.editType, meaning: ui.editMeaning };
  let languages = [];
  let entries = [];
  let selected = null;
  let language = '';
  let query = '';
  let offset = 0;
  let total = 0;
  let loading = false;
  let saving = false;
  let version = 0;
  let activeView = 'practice';
  let initialized = false;

  const canEdit = () => window.polytypeAdmin?.authenticated === true;
  const isDirty = () => selected !== null && fields.some((field) => inputs[field].value !== selected[field]);
  const canDiscard = () => !saving && (!isDirty() || window.confirm('Bạn có thay đổi chưa lưu. Bỏ các thay đổi này?'));

  function updateControls() {
    const dirty = isDirty();
    const creating = selected?.id === null;
    const editable = canEdit();
    ui.dictionaryDirty.hidden = !editable || !dirty;
    ui.dictionaryFormActions.hidden = !editable;
    ui.dictionarySaveBtn.hidden = !editable;
    ui.dictionaryCancelBtn.hidden = !editable;
    ui.dictionaryAddBtn.hidden = !editable;
    ui.dictionarySaveBtn.disabled = !editable || saving || !dirty;
    ui.dictionarySaveBtn.textContent = saving ? 'Đang lưu...' : creating ? 'Thêm từ' : 'Lưu thay đổi';
    ui.dictionaryCancelBtn.disabled = !editable || saving || (!dirty && !creating);
    ui.dictionaryCancelBtn.textContent = creating ? 'Hủy' : 'Hoàn tác';
    ui.dictionaryAddBtn.disabled = !editable || saving || loading || !language;
    ui.dictionaryLanguage.disabled = saving || !languages.length;
    ui.dictionarySearch.disabled = saving;
    ui.dictionarySearchBtn.disabled = saving || loading || !languages.length;
    ui.dictionaryPrevBtn.disabled = saving || loading || offset === 0;
    ui.dictionaryNextBtn.disabled = saving || loading || offset + PAGE_SIZE >= total;
    for (const input of Object.values(inputs)) {
      input.disabled = saving;
      input.readOnly = !editable;
    }
    updateDetailHeading();
    for (const button of ui.dictionaryList.querySelectorAll('button')) {
      button.disabled = saving;
      button.setAttribute('aria-pressed', String(button.dataset.id === String(selected?.id)));
    }
  }

  function updateDetailHeading() {
    const creating = selected?.id === null && canEdit();
    const languageName = languages.find((item) => item.id === selected?.language)?.name || '';
    ui.dictionaryEditHeading.textContent = creating ? `Thêm từ mới · ${languageName}` : 'Word detail';
    ui.dictionaryHint.textContent = !canEdit() ? 'Xem từ vựng, phiên âm, từ loại và nghĩa. Nghĩa ưu tiên tiếng Việt, sau đó tiếng Anh.'
      : creating ? 'Nhập từ vựng cho ngôn ngữ đã chọn. Nghĩa tiếng Việt, phiên âm IPA và từ loại là tùy chọn.'
        : 'Chỉnh sửa nghĩa và phiên âm đang hiển thị. Các nghĩa và phiên âm khác được giữ lại. Nghĩa ưu tiên tiếng Việt, sau đó tiếng Anh.';
  }

  function showEntry(entry, focus = false) {
    selected = entry;
    ui.dictionaryEditForm.hidden = !entry;
    ui.dictionaryEmpty.hidden = Boolean(entry);
    for (const field of fields) inputs[field].value = entry?.[field] || '';
    const name = { vi: 'Tiếng Việt', en: 'English' }[entry?.definitionLanguage] || entry?.definitionLanguage || '';
    ui.editMeaningLanguage.textContent = name ? `· ${name}` : '';
    ui.dictionarySaveStatus.textContent = '';
    ui.dictionarySaveStatus.dataset.state = '';
    updateControls();
    if (focus) (canEdit() ? ui.editWord : ui.dictionaryEditHeading).focus();
  }

  function renderList() {
    ui.dictionaryList.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dictionary-entry';
      button.dataset.id = String(entry.id);
      const word = document.createElement('strong');
      word.textContent = entry.word;
      const meaning = document.createElement('span');
      meaning.textContent = entry.meaning || 'Chưa có nghĩa';
      button.append(word, meaning);
      button.addEventListener('click', () => {
        if (selected?.id === entry.id || !canDiscard()) return;
        showEntry(entry, true);
      });
      item.append(button);
      ui.dictionaryList.append(item);
    }
    ui.dictionaryCount.textContent = `${total.toLocaleString('vi-VN')} từ`;
    ui.dictionaryPageLabel.textContent = total ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} / ${total.toLocaleString('vi-VN')}` : '0 từ';
    ui.dictionaryStatus.textContent = total ? 'Chọn một từ để xem chi tiết.' : 'Không tìm thấy từ vựng. Hãy thử từ khóa khác.';
    updateControls();
  }

  async function loadEntries(nextOffset = 0, keepSelection = false) {
    const requestVersion = ++version;
    loading = true;
    offset = nextOffset;
    entries = [];
    total = 0;
    ui.dictionaryList.replaceChildren();
    ui.dictionaryCount.textContent = '';
    ui.dictionaryPageLabel.textContent = 'Đang tải...';
    ui.dictionaryRetryBtn.hidden = true;
    ui.dictionaryStatus.textContent = 'Đang tải từ vựng...';
    ui.dictionaryList.setAttribute('aria-busy', 'true');
    if (!keepSelection) showEntry(null);
    updateControls();
    try {
      const parameters = new URLSearchParams({ language, q: query, offset: String(offset), limit: String(PAGE_SIZE) });
      const response = await fetch(`/api/dictionary?${parameters}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Không thể tải từ vựng. Vui lòng thử lại.');
      const data = await response.json();
      if (requestVersion !== version) return;
      if (!Array.isArray(data.words) || !Number.isSafeInteger(data.total)) throw new Error('Dữ liệu từ vựng không hợp lệ.');
      if (offset > 0 && offset >= data.total) {
        return loadEntries(Math.max(0, Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE), keepSelection);
      }
      entries = data.words;
      total = data.total;
      renderList();
    } catch (error) {
      if (requestVersion !== version) return;
      ui.dictionaryStatus.textContent = error.message;
      ui.dictionaryPageLabel.textContent = 'Chưa tải được';
      ui.dictionaryRetryBtn.hidden = false;
    } finally {
      if (requestVersion === version) {
        loading = false;
        ui.dictionaryList.setAttribute('aria-busy', 'false');
        updateControls();
      }
    }
  }

  async function init() {
    initialized = true;
    ui.dictionaryStatus.textContent = 'Đang tải ngôn ngữ...';
    ui.dictionaryRetryBtn.hidden = true;
    try {
      const response = await fetch('/api/dictionary/languages', { cache: 'no-store' });
      if (!response.ok) throw new Error('Không thể tải ngôn ngữ. Vui lòng thử lại.');
      const data = await response.json();
      if (!Array.isArray(data.languages) || !data.languages.length) throw new Error('Chưa có ngôn ngữ.');
      languages = data.languages;
      ui.dictionaryLanguage.replaceChildren();
      for (const item of languages) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        ui.dictionaryLanguage.append(option);
      }
      const practiceLanguage = document.getElementById('langSelect').value;
      language = languages.some((item) => item.id === practiceLanguage) ? practiceLanguage : languages[0].id;
      ui.dictionaryLanguage.value = language;
      await loadEntries();
    } catch (error) {
      initialized = false;
      ui.dictionaryStatus.textContent = error.message;
      ui.dictionaryRetryBtn.hidden = false;
      updateControls();
    }
  }

  function setView() {
    const nextView = ['#dictionary', '#dictionaryHeading'].includes(window.location.hash) ? 'dictionary' : 'practice';
    if (activeView === 'dictionary' && nextView !== activeView && !canDiscard()) {
      window.history.replaceState(null, '', '#dictionary');
      return;
    }
    if (activeView === 'dictionary' && nextView !== activeView && isDirty()) showEntry(null);
    activeView = nextView;
    const dictionaryOpen = activeView === 'dictionary';
    ui.practicePage.hidden = dictionaryOpen;
    ui.dictionary.hidden = !dictionaryOpen;
    ui.currentPageLabel.textContent = dictionaryOpen ? 'Từ điển' : 'Luyện gõ';
    for (const [tab, active] of [[ui.practiceTab, !dictionaryOpen], [ui.dictionaryTab, dictionaryOpen]]) {
      tab.classList.toggle('is-active', active);
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    const skipLink = document.querySelector('.skip-link');
    skipLink.href = dictionaryOpen ? '#dictionaryHeading' : '#practice';
    skipLink.textContent = dictionaryOpen ? 'Đến phần từ điển' : 'Đến phần luyện gõ';
    window.dispatchEvent(new CustomEvent('polytype:viewchange', { detail: { view: activeView } }));
    if (dictionaryOpen && !initialized) init();
    if (dictionaryOpen && !document.getElementById('adminDialog').open) ui.dictionaryHeading.focus({ preventScroll: true });
    else if (window.location.hash === '#keyboard') document.getElementById('keyboard').scrollIntoView();
  }

  ui.dictionarySearchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!canDiscard()) return;
    query = ui.dictionarySearch.value.trim();
    loadEntries();
  });
  ui.dictionaryLanguage.addEventListener('change', () => {
    if (!canDiscard()) { ui.dictionaryLanguage.value = language; return; }
    language = ui.dictionaryLanguage.value;
    query = ui.dictionarySearch.value.trim();
    loadEntries();
  });
  for (const [button, direction] of [[ui.dictionaryPrevBtn, -1], [ui.dictionaryNextBtn, 1]]) {
    button.addEventListener('click', () => { if (canDiscard()) loadEntries(offset + direction * PAGE_SIZE); });
  }
  ui.dictionaryRetryBtn.addEventListener('click', () => {
    if (canDiscard()) initialized ? loadEntries(offset) : init();
  });
  ui.dictionaryEditForm.addEventListener('input', () => {
    ui.dictionarySaveStatus.textContent = '';
    updateControls();
  });
  ui.dictionaryAddBtn.addEventListener('click', () => {
    if (!canEdit() || ui.dictionaryAddBtn.disabled || !canDiscard()) return;
    showEntry({ id: null, language, word: '', ipa: '', type: '', meaning: '', definitionLanguage: 'vi' }, true);
  });
  ui.dictionaryCancelBtn.addEventListener('click', () => {
    if (canEdit() && !saving) showEntry(selected?.id === null ? null : selected);
  });
  ui.dictionaryEditForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canEdit() || !selected || saving || !isDirty() || !ui.dictionaryEditForm.reportValidity()) return;
    const creating = selected.id === null;
    const values = Object.fromEntries(fields.map((field) => [field, inputs[field].value]));
    if (creating) values.language = selected.language;
    saving = true;
    updateControls();
    ui.dictionarySaveStatus.textContent = 'Đang lưu thay đổi...';
    ui.dictionarySaveStatus.dataset.state = '';
    try {
      const response = await fetch(creating ? '/api/dictionary' : `/api/dictionary/${selected.id}`, {
        method: creating ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      const data = await response.json();
      if (response.status === 401) window.polytypeAdmin.requireLogin('Phiên admin đã hết hạn. Nhập lại khóa để tiếp tục; thay đổi của bạn vẫn được giữ lại.');
      if (!response.ok) throw new Error(data.error || 'Không thể lưu thay đổi. Vui lòng thử lại.');
      showEntry(data.word);
      ui.dictionarySaveStatus.textContent = creating
        ? 'Đã thêm từ mới. Từ vựng luyện tập đã được cập nhật.'
        : 'Đã lưu. Từ vựng luyện tập đã được cập nhật.';
      ui.dictionarySaveStatus.dataset.state = 'success';
      window.dispatchEvent(new CustomEvent('polytype:dictionary-saved'));
      if (creating) {
        query = data.word.word;
        ui.dictionarySearch.value = query;
      }
      loadEntries(creating ? 0 : offset, true);
    } catch (error) {
      ui.dictionarySaveStatus.textContent = error.message;
      ui.dictionarySaveStatus.dataset.state = 'error';
      if (canEdit()) ui.dictionarySaveStatus.focus();
    } finally {
      saving = false;
      updateControls();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (isDirty() || saving) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('hashchange', setView);
  window.addEventListener('polytype:adminchange', (event) => {
    if (event.detail.reason === 'logout') showEntry(null);
    else updateControls();
  });
  window.addEventListener('polytype:before-admin-logout', (event) => {
    if (!canDiscard()) event.preventDefault();
  });
  updateControls();
  setView();
})();
