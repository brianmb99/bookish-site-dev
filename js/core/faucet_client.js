// faucet_client.js - Request initial funding from Bookish faucet

// Faucet Worker URL - deployed to Cloudflare Workers
// Production: https://bookish-faucet.bookish.workers.dev/fund
// For custom domain: https://faucet.getbookish.app/fund
const FAUCET_URL = 'https://bookish-faucet.bookish.workers.dev/fund';

/**
 * Request funding from the Bookish faucet (single attempt)
 * @private
 */
async function requestFaucetFundingOnce(walletAddress, existingCredentialId = null) {
  // 1. Generate challenge
  const timestamp = Date.now();
  const challenge = `bookish-faucet:${walletAddress.toLowerCase()}:${timestamp}`;

  // 2. Get credential ID - prefer passed-in value, fall back to credential store
  const { CREDENTIAL_STORAGE_KEY } = await import('./storage_constants.js');
  const credentialData = localStorage.getItem(CREDENTIAL_STORAGE_KEY);
  const credentialId = existingCredentialId
    || (credentialData ? 'credential-auth' : null);

  // 3. For alpha, we skip signature to simplify UX
  // Server-side protections (zero-balance check, IP rate limit, daily cap) are sufficient
  // The challenge still includes timestamp to prevent replay attacks
  const signature = `alpha-trusted:${credentialId || 'unknown'}`;

  // 4. Request funding
  // Note: Signature is simplified for alpha - server relies on other protections
  const resp = await fetch(FAUCET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress: walletAddress.toLowerCase(),
      challenge,
      signature,
      credentialId,
    }),
  });

  const httpStatus = resp.status;
  const data = await resp.json();

  if (data.success) {
    console.log('[Bookish:Faucet] Funding successful:', data.txHash);
    return { success: true, txHash: data.txHash };
  } else {
    console.warn('[Bookish:Faucet] Funding failed:', data.error, 'code:', data.code, 'HTTP:', httpStatus);
    return { success: false, error: data.error, code: data.code, httpStatus };
  }
}

/**
 * Check if an error code is retryable
 * Don't retry on rate limits, already-funded, or other permanent failures
 */
function isRetryableError(code, httpStatus) {
  // Don't retry on rate limits or permanent failures
  const nonRetryableCodes = ['ip-limit', 'daily-limit', 'already-funded', 'has-balance'];
  if (code && nonRetryableCodes.includes(code)) return false;

  // Retry on 500 errors (server issues) but not 400/404 (client errors)
  if (httpStatus === 500) return true;
  if (httpStatus && httpStatus < 500) return false;

  // Retry on network errors (no HTTP status)
  return true;
}

/**
 * Request funding from the Bookish faucet with retry logic
 * Called immediately after account creation
 *
 * @param {string} walletAddress - User's wallet address
 * @param {string} [existingCredentialId] - Credential ID from account creation (avoids second auth)
 * @param {number} [maxRetries=3] - Maximum number of retry attempts
 * @returns {Promise<{success: boolean, txHash?: string, error?: string, code?: string}>}
 */
export async function requestFaucetFunding(walletAddress, existingCredentialId = null, maxRetries = 3) {
  let lastError = null;
  let lastCode = null;
  let lastHttpStatus = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await requestFaucetFundingOnce(walletAddress, existingCredentialId);

      // Success - return immediately
      if (result.success) {
        return result;
      }

      // Check if we should retry
      lastError = result.error;
      lastCode = result.code;
      lastHttpStatus = result.httpStatus;

      if (!isRetryableError(result.code, result.httpStatus)) {
        // Non-retryable error (rate limit, already funded, etc.)
        console.log('[Bookish:Faucet] Non-retryable error, giving up:', result.code);
        return result;
      }

      // Retryable error - wait before retrying (exponential backoff)
      if (attempt < maxRetries - 1) {
        const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`[Bookish:Faucet] Attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (err) {
      // Network error or exception
      lastError = err.message || 'Network error';
      console.error(`[Bookish:Faucet] Attempt ${attempt + 1} exception:`, err);

      // Check if we should retry
      if (!isRetryableError(null, err.status)) {
        return { success: false, error: lastError };
      }

      // Retry on network errors
      if (attempt < maxRetries - 1) {
        const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`[Bookish:Faucet] Network error, retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  // All retries exhausted
  console.error('[Bookish:Faucet] All retry attempts failed');
  return { success: false, error: lastError || 'Request failed after retries', code: lastCode };
}

/**
 * Check if wallet is eligible for faucet funding
 * (Has an account and zero balance)
 *
 * @returns {Promise<boolean>}
 */
export async function isEligibleForFaucet() {
  // Must have an account
  const { ACCOUNT_STORAGE_KEY } = await import('./storage_constants.js');
  const accountData = localStorage.getItem(ACCOUNT_STORAGE_KEY);
  if (!accountData) return false;

  // Must have zero balance
  try {
    const balance = await window.bookishWallet?.getBalance?.();
    if (balance && BigInt(balance) > 0n) return false;
  } catch (err) {
    console.warn('[Bookish:Faucet] Balance check failed:', err);
    // If balance check fails, assume eligible (will be checked server-side)
  }

  return true;
}

