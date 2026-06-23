// ============================================================
// frontend/js/admin-link.js
// Adds an "Admin" navigation entry — ONLY for users whose session role is
// 'admin'. Included on authenticated pages; self-contained and non-blocking.
// Non-admins never see the link (and the /admin route is server-side gated
// regardless, so this is purely cosmetic convenience).
// ============================================================
(function () {
  // Surface the "admin only" redirect message for non-admins who hit /admin.
  function showAdminOnlyNotice() {
    const params = new URLSearchParams(location.search);
    if (params.get('error') !== 'admin_only') return;
    const el = document.createElement('div');
    el.textContent = 'You do not have permission to access the admin panel.';
    el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;background:#f43f5e;color:#fff;font-weight:600;font-size:14px;padding:12px 20px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:Inter,system-ui,sans-serif;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
    // Clean the URL so a refresh doesn't re-show it.
    params.delete('error');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : ''));
  }

  async function init() {
    showAdminOnlyNotice();
    let me;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      me = await res.json();
    } catch (_) { return; }
    if (!me || !me.authenticated || !me.user || me.user.role !== 'admin') return;

    // Prefer slotting into an existing nav list; fall back to a floating pill.
    const navList = document.querySelector('.navbar-links');
    if (navList) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '/admin'; a.textContent = 'Admin';
      a.style.cssText = 'color:#f97316;font-weight:700;';
      li.appendChild(a); navList.insertBefore(li, navList.firstChild);
      return;
    }
    const navRight = document.querySelector('.nav-right');
    if (navRight) {
      const a = document.createElement('a');
      a.href = '/admin'; a.textContent = 'Admin';
      a.style.cssText = 'color:#f97316;font-weight:700;text-decoration:none;font-size:13px;';
      navRight.insertBefore(a, navRight.firstChild);
      return;
    }
    // Floating fallback so admins always have a way in.
    const pill = document.createElement('a');
    pill.href = '/admin'; pill.textContent = '⚙ Admin';
    pill.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9999;background:#f97316;color:#fff;font-weight:700;font-size:13px;padding:10px 16px;border-radius:99px;text-decoration:none;box-shadow:0 8px 24px rgba(249,115,22,.4);font-family:Inter,system-ui,sans-serif;';
    document.body.appendChild(pill);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
