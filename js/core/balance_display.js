// balance_display.js - User-friendly ETH balance formatting with USD estimates

// Protocol fee per new book: ~$0.01 at ~$2100/ETH (snapshot 2026-03-23)
const COST_PER_BOOK_WEI = 4700000000000n; // 4.7e12 wei = 0.0000047 ETH

// Below half the fee there's not enough for anything useful
const MIN_USEFUL_BALANCE_WEI = 2350000000000n; // ~half of COST_PER_BOOK_WEI

const ASSUMED_ETH_PRICE_USD = 2100;

/**
 * Parse an ETH balance into wei (BigInt).
 * Accepts: raw BigInt, numeric string of wei, or decimal ETH string (e.g. "0.001").
 */
function parseWei(input) {
  if (input == null) return 0n;
  if (typeof input === 'bigint') return input;

  if (typeof input === 'number') {
    if (isNaN(input)) return 0n;
    if (input < 1e9) return BigInt(Math.floor(input * 1e18));
    return BigInt(Math.floor(input));
  }

  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return 0n;
    const parsed = parseFloat(s);
    if (isNaN(parsed)) return 0n;
    if (s.includes('.') || parsed < 1) return BigInt(Math.floor(parsed * 1e18));
    return BigInt(Math.floor(parsed));
  }

  return BigInt(input || 0);
}

/**
 * Format an ETH balance as "~$X.XX (~N books)"
 *
 * @param {string|bigint|number} balanceETH - Balance in wei (raw BigInt or ETH decimal string)
 * @returns {string} Human-readable balance string
 */
export function formatBalanceAsBooks(balanceETH) {
  const balance = parseWei(balanceETH);

  if (balance <= 0n) return 'No balance';
  if (balance < MIN_USEFUL_BALANCE_WEI) return 'Balance too low';

  const ethFloat = Number(balance) / 1e18;
  const usd = (ethFloat * ASSUMED_ETH_PRICE_USD).toFixed(2);
  const books = balance / COST_PER_BOOK_WEI;

  if (books <= 0n) return `~$${usd}`;
  if (books === 1n) return `~$${usd} (~1 book)`;
  if (books < 100n) return `~$${usd} (~${books} books)`;
  return `~$${usd} (100+ books)`;
}

/**
 * Get balance status for UI styling
 *
 * @param {string|bigint|number} balanceETH
 * @returns {'empty'|'low'|'ok'|'good'}
 */
export function getBalanceStatus(balanceETH) {
  const balance = parseWei(balanceETH);
  const books = balance / COST_PER_BOOK_WEI;

  if (balance <= 0n) return 'empty';
  if (books < 3n) return 'low';
  if (books < 10n) return 'ok';
  return 'good';
}

/**
 * Check if balance is sufficient for at least one operation
 */
export function hasUsableBalance(balanceETH) {
  return parseWei(balanceETH) >= COST_PER_BOOK_WEI;
}
