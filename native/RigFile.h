// .rigsmith files: a rig's JSON, encrypted so only Rigsmith opens it and any tampering is caught.
//   "RIGSMITH" | version (1 byte) | IV (16) | AES-256-CBC ciphertext | HMAC-SHA256 of everything before it (32)
// The operating system's own crypto, no extra dependency: CommonCrypto on macOS, CNG (bcrypt) on Windows.
// Both write and read the same format, so a rig made on one opens on the other.

#pragma once
#include <juce_core/juce_core.h>
#include <optional>
#include <cstdlib>
#include <cstring>

#if JUCE_MAC
 #include <CommonCrypto/CommonCrypto.h>
#elif JUCE_WINDOWS
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #include <windows.h>
 #include <bcrypt.h>
 #pragma comment(lib, "bcrypt.lib")
#else
 #error "Rig files need macOS or Windows crypto"
#endif

namespace rigfile
{
constexpr size_t block = 16, digest = 32;

// ---- Primitives. Each returns false on failure. ----
#if JUCE_MAC
inline bool sha256 (const void* d, size_t n, uint8_t out[digest]) { CC_SHA256 (d, (CC_LONG) n, out); return true; }
inline bool hmac256 (const uint8_t key[32], const void* d, size_t n, uint8_t out[digest]) { CCHmac (kCCHmacAlgSHA256, key, 32, d, n, out); return true; }
inline bool random (uint8_t* out, size_t n) { arc4random_buf (out, n); return true; }
// AES-256-CBC with PKCS7 padding. `written` is the output length.
inline bool aes (bool encrypt, const uint8_t key[32], const uint8_t iv[block], const void* in, size_t inLen, void* out, size_t cap, size_t& written)
{
    return CCCrypt (encrypt ? kCCEncrypt : kCCDecrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, key, 32, iv, in, inLen, out, cap, &written) == kCCSuccess;
}
#else
inline bool sha256 (const void* d, size_t n, uint8_t out[digest])
{
    return BCryptHash (BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, (PUCHAR) d, (ULONG) n, out, (ULONG) digest) >= 0;
}
inline bool hmac256 (const uint8_t key[32], const void* d, size_t n, uint8_t out[digest])
{
    return BCryptHash (BCRYPT_HMAC_SHA256_ALG_HANDLE, (PUCHAR) key, 32, (PUCHAR) d, (ULONG) n, out, (ULONG) digest) >= 0;
}
inline bool random (uint8_t* out, size_t n) { return BCryptGenRandom (nullptr, out, (ULONG) n, BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0; }
inline bool aes (bool encrypt, const uint8_t key[32], const uint8_t iv[block], const void* in, size_t inLen, void* out, size_t cap, size_t& written)
{
    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_KEY_HANDLE k = nullptr;
    bool ok = BCryptOpenAlgorithmProvider (&alg, BCRYPT_AES_ALGORITHM, nullptr, 0) >= 0
           && BCryptSetProperty (alg, BCRYPT_CHAINING_MODE, (PUCHAR) BCRYPT_CHAIN_MODE_CBC, (ULONG) sizeof (BCRYPT_CHAIN_MODE_CBC), 0) >= 0
           && BCryptGenerateSymmetricKey (alg, &k, nullptr, 0, (PUCHAR) key, 32, 0) >= 0;
    ULONG got = 0;
    if (ok)
    {
        uint8_t ivCopy[block]; // CNG updates the IV in place
        std::memcpy (ivCopy, iv, block);
        auto* f = encrypt ? BCryptEncrypt : BCryptDecrypt;
        ok = f (k, (PUCHAR) in, (ULONG) inLen, nullptr, ivCopy, (ULONG) block, (PUCHAR) out, (ULONG) cap, &got, BCRYPT_BLOCK_PADDING) >= 0;
    }
    if (k) BCryptDestroyKey (k);
    if (alg) BCryptCloseAlgorithmProvider (alg, 0);
    written = got;
    return ok;
}
#endif

// Compares without stopping at the first difference.
inline bool sameBytes (const uint8_t* a, const uint8_t* b, size_t n)
{
    uint8_t diff = 0;
    for (size_t i = 0; i < n; ++i) diff |= (uint8_t) (a[i] ^ b[i]);
    return diff == 0;
}

// ponytail: the key ships inside the app, so this keeps rigs from being read or edited outside
// Rigsmith, not from someone who takes the app apart. Add per-file passwords if that matters.
inline bool keys (uint8_t enc[32], uint8_t mac[32])
{
    static const char encSeed[] = "rigsmith.rig-file.encrypt.v1.7c1f4e2a9b";
    static const char macSeed[] = "rigsmith.rig-file.authenticate.v1.d05a83e6";
    return sha256 (encSeed, std::strlen (encSeed), enc) && sha256 (macSeed, std::strlen (macSeed), mac);
}

constexpr char magic[8] = { 'R', 'I', 'G', 'S', 'M', 'I', 'T', 'H' };
constexpr uint8_t version = 1;
constexpr size_t head = sizeof (magic) + 1 + block, tag = digest;

inline bool isRigFile (const juce::MemoryBlock& data)
{
    return data.getSize() >= sizeof (magic) && std::memcmp (data.getData(), magic, sizeof (magic)) == 0;
}

inline juce::MemoryBlock seal (const juce::String& json)
{
    uint8_t enc[32], mac[32];
    if (! keys (enc, mac)) return {};
    const auto* plain = json.toRawUTF8();
    const size_t plainLen = json.getNumBytesAsUTF8();

    juce::MemoryBlock out (head + plainLen + block + tag);
    auto* p = static_cast<uint8_t*> (out.getData());
    std::memcpy (p, magic, sizeof (magic));
    p[sizeof (magic)] = version;
    uint8_t* iv = p + sizeof (magic) + 1;
    if (! random (iv, block)) return {};

    size_t written = 0;
    if (! aes (true, enc, iv, plain, plainLen, p + head, plainLen + block, written)) return {};
    if (! hmac256 (mac, p, head + written, p + head + written)) return {};
    out.setSize (head + written + tag);
    return out;
}

// The rig's JSON, or nothing when the file isn't ours, was cut short or was altered.
inline std::optional<juce::String> open (const juce::MemoryBlock& data)
{
    const auto* p = static_cast<const uint8_t*> (data.getData());
    const size_t size = data.getSize();
    if (! isRigFile (data) || size < head + block + tag || p[sizeof (magic)] != version)
        return std::nullopt;

    uint8_t enc[32], mac[32], expected[tag];
    if (! keys (enc, mac)) return std::nullopt;
    const size_t body = size - tag;
    if (! hmac256 (mac, p, body, expected) || ! sameBytes (expected, p + body, tag))
        return std::nullopt;

    juce::MemoryBlock plain (body - head);
    size_t written = 0;
    if (! aes (false, enc, p + sizeof (magic) + 1, p + head, body - head, plain.getData(), plain.getSize(), written))
        return std::nullopt;
    return juce::String::fromUTF8 (static_cast<const char*> (plain.getData()), (int) written);
}
} // namespace rigfile
