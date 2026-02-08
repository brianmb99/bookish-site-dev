/**
 * crypto_utils.js
 * 
 * Password-based encryption utilities using WebCrypto API
 * - PBKDF2 for key derivation (100,000 iterations)
 * - AES-GCM for authenticated encryption
 * - Random IV and salt per encryption
 */

/**
 * Encrypts plaintext using password-derived AES-GCM key
 * @param {string} plaintext - Text to encrypt
 * @param {string} password - User password for key derivation
 * @returns {Promise<{iv: string, salt: string, ciphertext: string}>} Base64-encoded encrypted data
 */
export async function encryptWithPassword(plaintext, password) {
  // Generate random salt for PBKDF2 (prevents rainbow tables)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  
  // Derive AES-256 key from password using PBKDF2
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  
  // Generate random IV (ensures different ciphertext for same plaintext)
  const iv = crypto.getRandomValues(new Uint8Array(12));
  
  // Encrypt plaintext
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  
  // Return base64-encoded components
  return {
    iv: arrayBufferToBase64(iv),
    salt: arrayBufferToBase64(salt),
    ciphertext: arrayBufferToBase64(ciphertext)
  };
}

/**
 * Decrypts ciphertext using password-derived AES-GCM key
 * @param {string} ivBase64 - Base64-encoded IV
 * @param {string} saltBase64 - Base64-encoded salt
 * @param {string} ciphertextBase64 - Base64-encoded ciphertext
 * @param {string} password - User password for key derivation
 * @returns {Promise<string>} Decrypted plaintext
 * @throws {Error} If password is incorrect or data is corrupted
 */
export async function decryptWithPassword(ivBase64, saltBase64, ciphertextBase64, password) {
  // Convert base64 to ArrayBuffers
  const iv = base64ToArrayBuffer(ivBase64);
  const salt = base64ToArrayBuffer(saltBase64);
  const ciphertext = base64ToArrayBuffer(ciphertextBase64);
  
  // Derive AES-256 key from password using PBKDF2 (same parameters as encryption)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  
  // Decrypt ciphertext (will throw if password is wrong or data corrupted)
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      ciphertext
    );
    
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    // AES-GCM authentication failure = wrong password or corrupted data
    throw new Error('Incorrect password or corrupted data');
  }
}

/**
 * Converts ArrayBuffer to base64 string
 * @param {ArrayBuffer} buffer
 * @returns {string} Base64-encoded string
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Converts base64 string to ArrayBuffer
 * @param {string} base64
 * @returns {ArrayBuffer}
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
