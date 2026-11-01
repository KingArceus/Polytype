(() => {
  'use strict';

  const storageKey = 'polytype-theme';
  const root = document.documentElement;
  let theme = 'dark';
  try {
    if (localStorage.getItem(storageKey) === 'light') theme = 'light';
  } catch {
    // The switch still works when browser storage is unavailable.
  }

  function applyTheme(value) {
    theme = value === 'light' ? 'light' : 'dark';
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',
      theme === 'dark' ? '#080f1b' : '#f4f8fc');
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
    const toggle = document.getElementById('themeToggleBtn');
    if (toggle) {
      toggle.setAttribute('aria-checked', String(theme === 'dark'));
      toggle.title = theme === 'dark' ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối';
    }
  }

  // Apply the saved palette before the stylesheet paints the page.
  applyTheme(theme);

  function bindToggle() {
    applyTheme(theme);
    document.getElementById('themeToggleBtn')?.addEventListener('click', (event) => {
      applyTheme(theme === 'dark' ? 'light' : 'dark');
      try {
        localStorage.setItem(storageKey, theme);
      } catch {
        // Saving preferences is optional; changing the palette is not.
      }
      if (event.detail > 0 && !document.getElementById('practicePage')?.hidden) {
        document.getElementById('practice')?.focus({ preventScroll: true });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindToggle, { once: true });
  } else {
    bindToggle();
  }

  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue);
  });
})();
