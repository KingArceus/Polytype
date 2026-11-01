(() => {
  'use strict';

  const adminRoute = /^\/admin\/?$/.test(window.location.pathname);
  const ui = Object.fromEntries([
    'adminDialog', 'adminLoginForm', 'adminKey', 'adminLoginBtn', 'adminLoginStatus',
    'adminLogoutBtn', 'adminAccessLink', 'workspaceModeLabel'
  ].map((id) => [id, document.getElementById(id)]));
  let authenticated = false;
  let busy = false;
  let configured = true;
  let sessionCheckVersion = 0;

  function updateControls() {
    ui.adminLoginBtn.disabled = busy || !configured;
    ui.adminKey.disabled = busy || !configured;
    ui.adminLogoutBtn.disabled = busy;
    ui.adminLoginBtn.textContent = busy ? 'Đang kiểm tra...' : 'Mở khóa admin';
  }

  function setAuthenticated(value, reason = 'session') {
    authenticated = value === true && adminRoute;
    ui.adminLogoutBtn.hidden = !authenticated;
    ui.workspaceModeLabel.textContent = authenticated ? 'Admin' : adminRoute ? 'Admin · khóa' : 'Góc tập trung';
    window.dispatchEvent(new CustomEvent('polytype:adminchange', { detail: { authenticated, reason } }));
    if (authenticated && ui.adminDialog.open) ui.adminDialog.close();
  }

  function requireLogin(message = '') {
    if (!adminRoute) return;
    sessionCheckVersion++;
    setAuthenticated(false, 'expired');
    ui.adminKey.value = '';
    ui.adminLoginStatus.textContent = message;
    ui.adminLoginStatus.dataset.state = message ? 'error' : '';
    if (!ui.adminDialog.open) ui.adminDialog.showModal();
    if (!busy && configured) ui.adminKey.focus();
  }

  // The reusable key is sent only when logging in. The browser manages the
  // opaque HttpOnly session cookie; neither key nor token enters web storage.
  window.polytypeAdmin = { get authenticated() { return authenticated; }, requireLogin };
  if (!adminRoute) return;

  document.title = 'Polytype · Admin';
  if (!window.location.hash) window.history.replaceState(null, '', '#dictionary');
  ui.adminAccessLink.href = '/#dictionary';
  ui.adminAccessLink.textContent = 'Bản công khai';

  async function checkSession() {
    if (busy) return;
    const version = ++sessionCheckVersion;
    busy = true;
    updateControls();
    try {
      const response = await fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Không thể kiểm tra phiên admin. Vui lòng thử lại.');
      const data = await response.json();
      if (version !== sessionCheckVersion) return;
      configured = data.configured === true;
      if (data.authenticated === true) {
        setAuthenticated(true);
      } else {
        requireLogin(configured ? '' : 'Máy chủ chưa cấu hình admin key. Hãy cấu hình khóa trên máy chủ rồi tải lại trang.');
      }
    } catch (error) {
      if (version === sessionCheckVersion) requireLogin(error.message);
    } finally {
      busy = false;
      updateControls();
      if (ui.adminDialog.open && configured) ui.adminKey.focus();
    }
  }

  ui.adminLoginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !configured || !ui.adminLoginForm.reportValidity()) return;
    busy = true;
    updateControls();
    ui.adminLoginStatus.textContent = 'Đang xác thực...';
    ui.adminLoginStatus.dataset.state = '';
    try {
      const response = await fetch('/api/admin/session', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: ui.adminKey.value })
      });
      const data = await response.json();
      if (!response.ok || data.authenticated !== true) throw new Error(data.error || 'Admin key không hợp lệ.');
      ui.adminLoginStatus.textContent = '';
      setAuthenticated(true, 'login');
    } catch (error) {
      ui.adminLoginStatus.textContent = error.message;
      ui.adminLoginStatus.dataset.state = 'error';
    } finally {
      ui.adminKey.value = '';
      busy = false;
      updateControls();
      if (ui.adminDialog.open) ui.adminKey.focus();
    }
  });

  ui.adminLogoutBtn.addEventListener('click', async () => {
    if (busy || !window.dispatchEvent(new CustomEvent('polytype:before-admin-logout', { cancelable: true }))) return;
    busy = true;
    updateControls();
    try {
      const response = await fetch('/api/admin/session', { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Không thể đăng xuất. Kiểm tra kết nối rồi tải lại trang.');
      setAuthenticated(false, 'logout');
      requireLogin('Đã đăng xuất admin.');
      ui.adminLoginStatus.dataset.state = '';
    } catch (error) {
      requireLogin(error.message);
    } finally {
      busy = false;
      updateControls();
      if (ui.adminDialog.open) ui.adminKey.focus();
    }
  });
  ui.adminDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    window.location.assign('/#dictionary');
  });
  window.addEventListener('focus', () => {
    if (authenticated && !ui.adminDialog.open) return checkSession();
  });
  requireLogin();
  checkSession();
})();
