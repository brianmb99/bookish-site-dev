// coinbase_onramp.js - Coinbase Onramp integration with server-side session token generation
// Client calls server endpoint to get session token, then opens Coinbase Onramp widget

/**
 * Coinbase Onramp configuration
 * Base mainnet (chainId: 8453) for Base ETH purchases
 *
 * Always uses Cloudflare Worker for session token generation.
 * For local development, use `wrangler dev` in the coinbase-onramp directory.
 */
// Cloudflare Worker URL for Coinbase Onramp session token generation
const COINBASE_WORKER_URL = 'https://bookish-coinbase-onramp.bookish.workers.dev';

const COINBASE_CONFIG = {
  chainId: 8453,
  chainName: 'Base',
  ONRAMP_URL_BASE: 'https://pay.coinbase.com/buy/select-asset',
  // Always use Cloudflare Worker (works for both local dev and production)
  SESSION_TOKEN_ENDPOINT: `${COINBASE_WORKER_URL}/api/coinbase/session-token`
};

/**
 * Generate session token by calling server endpoint
 * @param {string} destinationAddress - Base wallet address to receive ETH
 * @returns {Promise<{sessionToken: string, appId: string}>}
 */
async function generateSessionToken(destinationAddress) {
  try {
    console.log('[Bookish:CoinbaseOnramp] Requesting session token from server...');

    const response = await fetch(COINBASE_CONFIG.SESSION_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        destinationAddress,
        chainId: COINBASE_CONFIG.chainId
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(errorData.message || `Server error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.sessionToken) {
      throw new Error('Session token not found in server response');
    }

    console.log('[Bookish:CoinbaseOnramp] Session token received');
    return {
      sessionToken: data.sessionToken,
      appId: data.appId
    };
  } catch (error) {
    console.error('[Bookish:CoinbaseOnramp] Session token generation failed:', error);
    throw new Error(`Failed to generate session token: ${error.message}`);
  }
}

/**
 * Generate Coinbase Onramp URL with session token
 * @param {string} destinationAddress - Base wallet address to receive ETH
 * @returns {Promise<string>} Coinbase Onramp URL
 */
async function generateOnrampURL(destinationAddress) {
  // Get session token from server
  const { sessionToken, appId } = await generateSessionToken(destinationAddress);

  // Per Coinbase Onramp API docs: With sessionToken, addresses and assets are IN the token,
  // NOT in the URL parameters. The URL should only contain sessionToken.
  // The session token already encapsulates the addresses, blockchains, and assets.
  const params = new URLSearchParams({
    sessionToken
  });

  return `${COINBASE_CONFIG.ONRAMP_URL_BASE}?${params.toString()}`;
}

/**
 * Open Coinbase Onramp widget in popup window
 * @param {string} destinationAddress - Base wallet address to receive ETH
 * @param {Object} options - { onSuccess, onError, onClose }
 * @returns {Promise<void>}
 */
export async function openOnrampWidget(destinationAddress, options = {}) {
  const { onSuccess, onError, onClose } = options;

  try {
    console.log('[Bookish:CoinbaseOnramp] Opening widget for address:', destinationAddress);

    // Generate onramp URL with session token
    const onrampURL = await generateOnrampURL(destinationAddress);
    console.log('[Bookish:CoinbaseOnramp] Generated Onramp URL');

    // Open in popup window
    const width = 500;
    const height = 700;
    const left = (window.screen.width - width) / 2;
    const top = (window.screen.height - height) / 2;

    const popup = window.open(
      onrampURL,
      'CoinbaseOnramp',
      `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
    );

    if (!popup) {
      throw new Error('Popup blocked. Please allow popups for this site.');
    }

    console.log('[Bookish:CoinbaseOnramp] Widget opened in popup');

    // Monitor popup for close/completion
    const checkClosed = setInterval(() => {
      if (popup.closed) {
        clearInterval(checkClosed);
        console.log('[Bookish:CoinbaseOnramp] Widget closed');
        if (onClose) onClose();
      }
    }, 500);

    // Note: Coinbase widget handles success/error internally
    // We rely on balance polling to detect incoming funds
    // Session token expires after 5 minutes, but widget should complete before then

  } catch (error) {
    console.error('[Bookish:CoinbaseOnramp] Failed to open widget:', error);
    if (onError) {
      onError(error);
    } else {
      throw error;
    }
  }
}

/**
 * Check if Coinbase Onramp is configured and ready
 * @returns {boolean}
 */
export function isCoinbaseOnrampConfigured() {
  // Always available - server handles configuration
  // Client can't check server config, so assume available
  // Server will return error if not configured
  return true;
}

/**
 * Get configuration status (for debugging)
 * @returns {Object}
 */
export function getCoinbaseConfigStatus() {
  return {
    configured: true,
    chainId: COINBASE_CONFIG.chainId,
    chainName: COINBASE_CONFIG.chainName,
    endpoint: COINBASE_CONFIG.SESSION_TOKEN_ENDPOINT
  };
}
