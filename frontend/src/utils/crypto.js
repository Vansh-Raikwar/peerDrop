/**
 * Cryptographic utility functions using Web Crypto API
 * for ECDH key exchange and AES-GCM encryption.
 */

// Generate an ECDH key pair (P-256)
export const generateECDHKeyPair = async () => {
    return await window.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey", "deriveBits"]
    );
};

// Export public key to a format suitable for transmission (JWK or base64 raw)
export const exportPublicKey = async (publicKey) => {
    const exported = await window.crypto.subtle.exportKey("spki", publicKey);
    return bufferToBase64(exported);
};

// Import a received public key
export const importPublicKey = async (base64Key) => {
    const buffer = base64ToBuffer(base64Key);
    return await window.crypto.subtle.importKey(
        "spki",
        buffer,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
    );
};

// Derive the shared AES-GCM key from our private key and their public key
export const deriveAESKey = async (privateKey, publicKey) => {
    return await window.crypto.subtle.deriveKey(
        { name: "ECDH", public: publicKey },
        privateKey,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
};

// Encrypt a chunk using AES-GCM
// Returns a concatenated ArrayBuffer: [IV (12 bytes)] + [Ciphertext]
export const encryptChunk = async (aesKey, chunkBuffer) => {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        aesKey,
        chunkBuffer
    );
    
    // Concatenate IV and cipher text into one flat ArrayBuffer
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    return result.buffer;
};

// Decrypt a chunk using AES-GCM
// Expects an ArrayBuffer: [IV (12 bytes)] + [Ciphertext]
export const decryptChunk = async (aesKey, encryptedBuffer) => {
    const encryptedArray = new Uint8Array(encryptedBuffer);
    const iv = encryptedArray.slice(0, 12);
    const data = encryptedArray.slice(12);
    
    return await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        aesKey,
        data
    );
};

// Helper: ArrayBuffer to Base64
function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// Helper: Base64 to ArrayBuffer
function base64ToBuffer(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}
