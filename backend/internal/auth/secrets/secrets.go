// Package secrets provides byte-exact parity with the NestJS backend's credential
// crypto so the Go service can read what Node wrote (shared database, no data
// migration). The exact formats are documented below.
//
//   - Passwords: scrypt$<saltHex>$<hashHex>, Node scrypt defaults (N=16384,r=8,p=1).
//   - Opaque tokens: sha256 hex (refresh / invitation token at-rest hashing).
//   - Provider API keys: AES-256-GCM, key = scrypt(secret,"oc-ai-config",32),
//     12-byte nonce, base64 {cipher,iv,tag}.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"strings"

	"golang.org/x/crypto/scrypt"
)

// Node's node:crypto scryptSync default cost parameters.
const (
	scryptN = 16384
	scryptR = 8
	scryptP = 1

	aiKeyLen = 32
	aiSalt   = "oc-ai-config"
)

// VerifyPassword checks a plaintext password against a stored hash in the
// `scrypt$<saltHex>$<hashHex>` format produced by ScryptPasswordHasher.
func VerifyPassword(password, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 3 || parts[0] != "scrypt" {
		return false
	}
	salt, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	expected, err := hex.DecodeString(parts[2])
	if err != nil || len(expected) == 0 {
		return false
	}
	derived, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, len(expected))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(expected, derived) == 1
}

// HashPassword produces a `scrypt$<saltHex>$<hashHex>` hash in the same format
// (16-byte salt, keylen 64, Node scrypt defaults) the NestJS hasher writes, so
// hashes are interchangeable across the migration.
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	derived, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, 64)
	if err != nil {
		return "", err
	}
	return "scrypt$" + hex.EncodeToString(salt) + "$" + hex.EncodeToString(derived), nil
}

// HashToken mirrors the backend's hashToken(): sha256 hex of an opaque token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Encrypted is the at-rest envelope for an encrypted provider API key.
type Encrypted struct {
	Cipher string `json:"cipher"`
	IV     string `json:"iv"`
	Tag    string `json:"tag"`
}

func aiKey(secret string) ([]byte, error) {
	return scrypt.Key([]byte(secret), []byte(aiSalt), scryptN, scryptR, scryptP, aiKeyLen)
}

// DecryptAISecret reverses ai/crypto.ts encryptSecret.
func DecryptAISecret(enc Encrypted, secret string) (string, error) {
	key, err := aiKey(secret)
	if err != nil {
		return "", err
	}
	ct, err := base64.StdEncoding.DecodeString(enc.Cipher)
	if err != nil {
		return "", err
	}
	iv, err := base64.StdEncoding.DecodeString(enc.IV)
	if err != nil {
		return "", err
	}
	tag, err := base64.StdEncoding.DecodeString(enc.Tag)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		return "", err
	}
	// Node stores ciphertext and tag separately; Go's GCM expects ciphertext||tag.
	plain, err := gcm.Open(nil, iv, append(ct, tag...), nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

// EncryptAISecret produces the same envelope encryptSecret() would, given a
// 12-byte nonce. Exposed for round-trip tests and Go-side writes.
func EncryptAISecret(plain, secret string, nonce []byte) (Encrypted, error) {
	key, err := aiKey(secret)
	if err != nil {
		return Encrypted{}, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return Encrypted{}, err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, len(nonce))
	if err != nil {
		return Encrypted{}, err
	}
	sealed := gcm.Seal(nil, nonce, []byte(plain), nil)
	overhead := gcm.Overhead()
	ct := sealed[:len(sealed)-overhead]
	tag := sealed[len(sealed)-overhead:]
	return Encrypted{
		Cipher: base64.StdEncoding.EncodeToString(ct),
		IV:     base64.StdEncoding.EncodeToString(nonce),
		Tag:    base64.StdEncoding.EncodeToString(tag),
	}, nil
}
