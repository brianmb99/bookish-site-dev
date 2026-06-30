export function renderSubscriptionSection({
  subscription,
  activeEntryCount = 0,
} = {}) {
  const subStatus = subscription?.getStatus?.();
  if (subStatus === 'free') {
    // Free-for-all launch: no paywall, no dead-end checkout (Stripe is dormant).
    // Keep the Subscription concept visible but honest \u2014 paid plans may arrive
    // later as optional support; nothing is gated today.
    return `
      <div class="account-panel-subscription">
        <div class="account-panel-sub-label">Subscription</div>
        <div class="account-panel-sub-value">Bookish is free \u2014 no subscription needed.</div>
        <div class="account-panel-sub-pitch">Save as many books as you like. Paid plans may arrive later to support permanent storage \u2014 you'll never lose access to anything you've saved.</div>
      </div>
    `;
  }
  if (subStatus === 'lapsed') {
    return `
      <div class="account-panel-subscription">
        <div class="account-panel-sub-label">Subscription</div>
        <div class="account-panel-sub-value">Expired \u2014 renew to keep adding books</div>
        <button type="button" id="accountSubscribeBtn" class="account-panel-sub-btn" data-subscribe-action="renew">Renew \u2014 $10/year</button>
      </div>
    `;
  }
  if (subStatus === 'subscribed') {
    const periodEndIso = subscription.getCurrentPeriodEnd?.();
    let renewLine = 'Subscribed';
    if (periodEndIso) {
      try {
        const d = new Date(periodEndIso);
        renewLine = `Subscribed \u2014 renews ${d.toLocaleDateString('en-US', { dateStyle: 'long' })}`;
      } catch { /* fall back to plain label */ }
    }
    return `
      <div class="account-panel-subscription">
        <div class="account-panel-sub-label">Subscription</div>
        <div class="account-panel-sub-value">${renewLine}</div>
        <button type="button" id="accountManageBtn" class="account-panel-sub-btn account-panel-sub-btn-secondary">Manage subscription <span aria-hidden="true" class="external-link-icon">\u2197</span></button>
      </div>
    `;
  }
  return '';
}

export function wireSubscriptionSection(content, {
  subscription,
  onError = () => {},
  setTimeoutRef = setTimeout,
} = {}) {
  const subscribeBtn = content.querySelector('#accountSubscribeBtn');
  if (subscribeBtn) {
    subscribeBtn.addEventListener('click', async () => {
      subscribeBtn.disabled = true;
      try {
        await subscription.startCheckout();
      } catch (err) {
        onError('[AccountUI] Checkout failed:', err?.message || err);
        subscribeBtn.disabled = false;
        subscribeBtn.textContent = "Couldn't start checkout \u2014 try again";
      }
    });
  }

  const manageBtn = content.querySelector('#accountManageBtn');
  if (manageBtn) {
    manageBtn.addEventListener('click', async () => {
      manageBtn.disabled = true;
      try {
        await subscription.openPortal();
      } catch (err) {
        onError('[AccountUI] Portal open failed:', err?.message || err);
        manageBtn.textContent = "Couldn't open portal \u2014 try again";
      } finally {
        setTimeoutRef(() => { manageBtn.disabled = false; }, 1500);
      }
    });
  }
}
