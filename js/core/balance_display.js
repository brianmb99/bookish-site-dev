// balance_display.js - User-friendly balance formatting

/**
 * Estimated cost per book upload in wei.
 * This is dominated by the flat protocol fee (0.0000025 ETH per upload)
 * plus a small gas allowance for the fee transaction on Base L2.
 * Irys storage may be free (subsidised) or charged via 402 auto-funding;
 * when Irys charges, the actual cost per book will be slightly higher.
 *
 * Must stay in sync with PROTOCOL_CONFIG.FLAT_FEE_WEI in protocol_config.js
 */
const ESTIMATED_COST_PER_BOOK_WEI = BigInt('2500000000000'); // 0.0000025 ETH (matches flat fee)

/**
 * Minimum useful balance (below this, can't do much)
 */
const MIN_USEFUL_BALANCE_WEI = BigInt('500000000000'); // 0.0000005 ETH

/**
 * Format a wallet balance as "~X books remaining"
 *
 * @param {string|bigint|number} balanceWei - Balance in wei (can be ETH string or wei)
 * @param {Object} options - Formatting options
 * @param {boolean} options.showExact - Include exact ETH in parentheses
 * @returns {string} Human-readable balance string
 */
export function formatBalanceAsBooks(balanceWei, options = {}) {
  // Convert ETH string to wei if needed
  let balance;
  if (typeof balanceWei === 'string') {
    // Handle empty/null strings
    if (!balanceWei || balanceWei.trim() === '') {
      balance = 0n;
    } else {
      const parsed = parseFloat(balanceWei);
      if (isNaN(parsed)) {
        balance = 0n;
      } else if (parsed < 1 || balanceWei.includes('.')) {
        // Likely ETH format (has decimal or < 1), convert to wei
        balance = BigInt(Math.floor(parsed * 1e18));
      } else if (parsed < 1000) {
        // Small integer without decimal - likely ETH (e.g., "1" = 1 ETH)
        balance = BigInt(Math.floor(parsed * 1e18));
      } else {
        // Large number without decimal - likely wei format
        balance = BigInt(Math.floor(parsed));
      }
    }
  } else if (typeof balanceWei === 'number') {
    // If number is < 1, assume ETH; otherwise assume wei
    if (isNaN(balanceWei)) {
      balance = 0n;
    } else if (balanceWei < 1) {
      balance = BigInt(Math.floor(balanceWei * 1e18));
    } else {
      balance = BigInt(Math.floor(balanceWei));
    }
  } else if (balanceWei == null) {
    balance = 0n;
  } else {
    balance = BigInt(balanceWei || 0);
  }

  // Zero balance
  if (balance <= 0n) {
    return 'No balance';
  }

  // Below minimum useful
  if (balance < MIN_USEFUL_BALANCE_WEI) {
    return 'Balance too low';
  }

  // Calculate books
  const booksRemaining = balance / ESTIMATED_COST_PER_BOOK_WEI;

  // Format based on amount
  let display;
  if (booksRemaining <= 0n) {
    display = 'Balance low';
  } else if (booksRemaining === 1n) {
    display = '~1 book remaining';
  } else if (booksRemaining < 10n) {
    display = `~${booksRemaining} books remaining`;
  } else if (booksRemaining < 100n) {
    // Round to nearest 5 for cleaner display
    const remainder = booksRemaining % 5n;
    let rounded;
    if (remainder >= 3n) {
      // Round up to next 5
      rounded = booksRemaining - remainder + 5n;
    } else {
      // Round down to previous 5
      rounded = booksRemaining - remainder;
    }
    // Ensure we don't go below 10 or above 95
    if (rounded < 10n) rounded = 10n;
    if (rounded > 95n) rounded = 95n;
    display = `~${rounded} books remaining`;
  } else {
    display = '100+ books remaining';
  }

  // Optionally append exact balance
  if (options.showExact) {
    const ethBalance = formatWeiAsEth(balance);
    display += ` (${ethBalance})`;
  }

  return display;
}

/**
 * Format wei as ETH string with appropriate precision
 */
function formatWeiAsEth(wei) {
  const balance = BigInt(wei);
  const eth = Number(balance) / 1e18;

  if (eth < 0.0001) {
    return eth.toExponential(2) + ' ETH';
  } else if (eth < 0.01) {
    return eth.toFixed(6) + ' ETH';
  } else {
    return eth.toFixed(4) + ' ETH';
  }
}

/**
 * Get balance status for UI styling
 *
 * @param {string|bigint|number} balanceWei
 * @returns {'empty'|'low'|'ok'|'good'}
 */
export function getBalanceStatus(balanceWei) {
  // Convert ETH string to wei if needed (same logic as formatBalanceAsBooks)
  let balance;
  if (typeof balanceWei === 'string') {
    if (!balanceWei || balanceWei.trim() === '') {
      balance = 0n;
    } else {
      const parsed = parseFloat(balanceWei);
      if (isNaN(parsed)) {
        balance = 0n;
      } else if (parsed < 1 || balanceWei.includes('.')) {
        balance = BigInt(Math.floor(parsed * 1e18));
      } else if (parsed < 1000) {
        balance = BigInt(Math.floor(parsed * 1e18));
      } else {
        balance = BigInt(Math.floor(parsed));
      }
    }
  } else if (typeof balanceWei === 'number') {
    if (isNaN(balanceWei)) {
      balance = 0n;
    } else if (balanceWei < 1) {
      balance = BigInt(Math.floor(balanceWei * 1e18));
    } else {
      balance = BigInt(Math.floor(balanceWei));
    }
  } else if (balanceWei == null) {
    balance = 0n;
  } else {
    balance = BigInt(balanceWei || 0);
  }

  const books = balance / ESTIMATED_COST_PER_BOOK_WEI;

  if (balance <= 0n) return 'empty';
  if (books < 3n) return 'low';
  if (books < 10n) return 'ok';
  return 'good';
}

/**
 * Check if balance is sufficient for at least one operation
 */
export function hasUsableBalance(balanceWei) {
  // Convert ETH string to wei if needed (same logic as formatBalanceAsBooks)
  let balance;
  if (typeof balanceWei === 'string') {
    if (!balanceWei || balanceWei.trim() === '') {
      balance = 0n;
    } else {
      const parsed = parseFloat(balanceWei);
      if (isNaN(parsed)) {
        balance = 0n;
      } else if (parsed < 1 || balanceWei.includes('.')) {
        balance = BigInt(Math.floor(parsed * 1e18));
      } else if (parsed < 1000) {
        balance = BigInt(Math.floor(parsed * 1e18));
      } else {
        balance = BigInt(Math.floor(parsed));
      }
    }
  } else if (typeof balanceWei === 'number') {
    if (isNaN(balanceWei)) {
      balance = 0n;
    } else if (balanceWei < 1) {
      balance = BigInt(Math.floor(balanceWei * 1e18));
    } else {
      balance = BigInt(Math.floor(balanceWei));
    }
  } else if (balanceWei == null) {
    balance = 0n;
  } else {
    balance = BigInt(balanceWei || 0);
  }

  return balance >= MIN_USEFUL_BALANCE_WEI;
}

