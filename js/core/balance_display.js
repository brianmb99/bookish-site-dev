// balance_display.js - User-friendly USDC balance formatting

// $0.005 per upload = 5000 USDC units (6 decimals)
const COST_PER_BOOK_USDC = 5000n;

// Below $0.001 (1000 units) there's not enough for anything useful
const MIN_USEFUL_BALANCE_USDC = 1000n;

/**
 * Parse a USDC balance into raw units (BigInt).
 * Accepts: raw BigInt, numeric string of units, or decimal dollar string (e.g. "0.05").
 */
function parseUSDC(input) {
  if (input == null) return 0n;
  if (typeof input === 'bigint') return input;

  if (typeof input === 'number') {
    if (isNaN(input)) return 0n;
    if (input < 1000) return BigInt(Math.floor(input * 1e6));
    return BigInt(Math.floor(input));
  }

  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return 0n;
    const parsed = parseFloat(s);
    if (isNaN(parsed)) return 0n;
    // If it looks like a dollar amount (has decimal or < 1), convert to raw units
    if (s.includes('.') || parsed < 1) return BigInt(Math.floor(parsed * 1e6));
    // Otherwise treat as raw USDC units
    return BigInt(Math.floor(parsed));
  }

  return BigInt(input || 0);
}

/**
 * Format a USDC balance as "$X.XX (~N books)"
 *
 * @param {string|bigint|number} balanceUSDC - Balance in USDC (raw units or dollar string)
 * @returns {string} Human-readable balance string
 */
export function formatBalanceAsBooks(balanceUSDC) {
  const balance = parseUSDC(balanceUSDC);

  if (balance <= 0n) return 'No balance';
  if (balance < MIN_USEFUL_BALANCE_USDC) return 'Balance too low';

  const dollars = (Number(balance) / 1e6).toFixed(2);
  const books = balance / COST_PER_BOOK_USDC;

  if (books <= 0n) return `$${dollars}`;
  if (books === 1n) return `$${dollars} (~1 book)`;
  if (books < 100n) return `$${dollars} (~${books} books)`;
  return `$${dollars} (100+ books)`;
}

/**
 * Get balance status for UI styling
 *
 * @param {string|bigint|number} balanceUSDC
 * @returns {'empty'|'low'|'ok'|'good'}
 */
export function getBalanceStatus(balanceUSDC) {
  const balance = parseUSDC(balanceUSDC);
  const books = balance / COST_PER_BOOK_USDC;

  if (balance <= 0n) return 'empty';
  if (books < 3n) return 'low';
  if (books < 10n) return 'ok';
  return 'good';
}

/**
 * Check if balance is sufficient for at least one operation
 */
export function hasUsableBalance(balanceUSDC) {
  return parseUSDC(balanceUSDC) >= COST_PER_BOOK_USDC;
}
