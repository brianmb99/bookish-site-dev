// account_friends_section.js - Account panel Friends section UI.

function noop() {}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * Static Account -> Friends section markup. Account keeps the read-only
 * verification lists while the Friends drawer owns invite creation.
 */
export function renderAccountFriendsSectionMarkup() {
  return `
      <div class="account-panel-friends" id="accountPanelFriends">
        <div class="account-panel-sub-label">Friends</div>
        <!-- #122: the add-a-friend entry moved to the Friends drawer (header glyph).
             Account keeps the read-only Connections + Pending invites lists for
             power-user verification. To invite someone, open the Friends drawer
             from the header and tap Invite.
             #124: added the "Show in header" toggle so users who hid the glyph
             from the drawer have a clear path to re-enable it. -->
        <!-- #146: switched from native checkbox to the .toggle-switch
             pattern used by the Owned toggle and the privacy-add toggle.
             Order matters: input must immediately precede .toggle-track
             so the input:checked + .toggle-track adjacent-sibling rule
             applies. Input id stays the same so the wiring still finds it. -->
        <label class="toggle-switch account-friends-toggle" for="accountFriendsShowToggle">
          <span class="account-friends-toggle-label">Show in header</span>
          <input type="checkbox" id="accountFriendsShowToggle" />
          <span class="toggle-track"></span>
        </label>
        <div class="account-friends-section" id="accountConnectionsSection" style="display:none;">
          <div class="account-friends-heading">Connections</div>
          <ul class="account-friends-list" id="accountConnectionsList"></ul>
        </div>
        <div class="account-friends-section" id="accountPendingInvitesSection" style="display:none;">
          <div class="account-friends-heading">Pending invites</div>
          <ul class="account-friends-list" id="accountPendingInvitesList"></ul>
        </div>
        <div class="account-friends-status" id="accountFriendsStatus" style="display:none;"></div>
      </div>
  `;
}

export function getAccountFriendLabel(connection) {
  return (connection.label && connection.label.trim())
    || (connection.email ? connection.email : connection.share_pub.slice(0, 8));
}

export function getOutstandingInvites(invites) {
  return invites.filter(invite => !invite.redeemed_at);
}

export function renderConnectionRows(connections) {
  return connections
    .map(connection => {
      const label = getAccountFriendLabel(connection);
      return `<li class="account-friend-row account-friend-row-connection"><span class="account-friend-label">${escapeHtml(label)}</span></li>`;
    })
    .join('');
}

export function renderPendingInviteRows(invites) {
  return getOutstandingInvites(invites)
    .map(inv => {
      const expires = inv.expires_at
        ? new Date(inv.expires_at * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })
        : '';
      const namePart = inv.display_name?.trim()
        ? `for ${escapeHtml(inv.display_name)}`
        : 'unnamed';
      return `
          <li class="account-friend-row account-friend-row-pending" data-pending-token="${escapeHtml(inv.token_id)}">
            <span class="account-friend-label">Invite ${namePart}</span>
            <span class="account-friend-meta">${expires ? 'Expires ' + escapeHtml(expires) : ''}</span>
            <button type="button" class="account-friend-revoke" data-revoke-token="${escapeHtml(inv.token_id)}">Revoke</button>
          </li>
        `;
    })
    .join('');
}

/**
 * Hydrate the Account -> Friends section: list connections by label and list
 * outstanding issued invites with revoke buttons.
 *
 * @param {HTMLElement} content
 */
export async function refreshAccountFriendsSection(content, deps = {}) {
  const {
    listConnections,
    listIssuedInvites,
    revokeInvite,
    onWarn = noop,
    onError = noop,
  } = deps;
  const connSection = content.querySelector('#accountConnectionsSection');
  const connList = content.querySelector('#accountConnectionsList');
  const invSection = content.querySelector('#accountPendingInvitesSection');
  const invList = content.querySelector('#accountPendingInvitesList');
  const status = content.querySelector('#accountFriendsStatus');
  if (!connSection || !connList || !invSection || !invList || !status) return;

  let connections = [];
  let invites = [];
  try {
    [connections, invites] = await Promise.all([
      listConnections(),
      listIssuedInvites(),
    ]);
  } catch (err) {
    status.style.display = 'block';
    status.textContent = "Couldn't load friends \u2014 try reopening Account.";
    onWarn('[AccountUI] friends fetch failed:', err?.message || err);
    return;
  }
  status.style.display = 'none';

  if (connections.length > 0) {
    connSection.style.display = 'block';
    connList.innerHTML = renderConnectionRows(connections);
  } else {
    connSection.style.display = 'none';
    connList.innerHTML = '';
  }

  const outstanding = getOutstandingInvites(invites);
  if (outstanding.length > 0) {
    invSection.style.display = 'block';
    invList.innerHTML = renderPendingInviteRows(outstanding);
    invList.querySelectorAll('[data-revoke-token]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const tokenId = btn.dataset.revokeToken;
        btn.disabled = true;
        btn.textContent = 'Revoking\u2026';
        try {
          await revokeInvite(tokenId);
          await refreshAccountFriendsSection(content, deps);
        } catch (err) {
          onError('[AccountUI] revoke failed:', err);
          btn.disabled = false;
          btn.textContent = 'Try again';
        }
      });
    });
  } else {
    invSection.style.display = 'none';
    invList.innerHTML = '';
  }
}

export function hydrateAccountFriendsSection(content, deps = {}) {
  const { onWarn = noop } = deps;
  refreshAccountFriendsSection(content, deps).catch(err =>
    onWarn('[AccountUI] friends hydrate failed:', err?.message || err)
  );
  return wireAccountFriendsVisibilityToggle(content, deps);
}

/**
 * Wire the Account -> Friends "Show in header" toggle to the shared local
 * header-glyph preference.
 */
export function wireAccountFriendsVisibilityToggle(content, deps = {}) {
  const {
    isFriendsHiddenFromHeader = () => false,
    setHideFriendsFromHeader = noop,
    friendsVisibilityEvent = 'bookish:friends-visibility-changed',
    windowObj = globalThis.window,
    documentObj = globalThis.document,
  } = deps;
  const showInHeaderToggle = content.querySelector('#accountFriendsShowToggle');
  if (!showInHeaderToggle) return noop;

  showInHeaderToggle.checked = !isFriendsHiddenFromHeader();
  const onToggleChange = () => {
    setHideFriendsFromHeader(!showInHeaderToggle.checked);
  };
  const onVisibilityChange = (e) => {
    const hidden = !!(e?.detail?.hidden);
    showInHeaderToggle.checked = !hidden;
  };
  showInHeaderToggle.addEventListener('change', onToggleChange);
  windowObj?.addEventListener?.(friendsVisibilityEvent, onVisibilityChange);

  const accountModal = documentObj?.getElementById?.('accountModal');
  const closeBtn = documentObj?.getElementById?.('accountModalClose');
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    showInHeaderToggle.removeEventListener('change', onToggleChange);
    windowObj?.removeEventListener?.(friendsVisibilityEvent, onVisibilityChange);
    if (closeBtn) closeBtn.removeEventListener('click', cleanup);
    if (accountModal) accountModal.removeEventListener('click', onBackdropClick);
  };
  const onBackdropClick = (e) => {
    if (e.target === accountModal) cleanup();
  };
  if (closeBtn) closeBtn.addEventListener('click', cleanup, { once: true });
  if (accountModal) accountModal.addEventListener('click', onBackdropClick);
  return cleanup;
}
