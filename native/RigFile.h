// .rigsmith files: a rig's JSON, encrypted so only Rigsmith opens it and any tampering is caught.
//   "RIGSMITH" | version (1 byte) | IV (16) | AES-256-CBC ciphertext | HMAC-SHA256 of everything before it (32)
// macOS CommonCrypto; no extra dependency.

#pragma once
#include <juce_core/juce_core.h>
#include <CommonCrypto/CommonCrypto.h>
#include <optional>
#include <cstdlib>
#include <cstring>

namespace rigfile
{
// ponytail: the key ships inside the app, so this keeps rigs from being read or edited outside
// Rigsmith, not from someone who takes the app apart. Add per-file passwords if that matters.
inline void keys (uint8_t enc[32], uint8_t mac[32])
{
    static const char encSeed[] = "rigsmith.rig-file.encrypt.v1.7c1f4e2a9b";
    static const char macSeed[] = "rigsmith.rig-file.authenticate.v1.d05a83e6";
    CC_SHA256 (encSeed, (CC_LONG) std::strlen (encSeed), enc);
    CC_SHA256 (macSeed, (CC_LONG) std::strlen (macSeed), mac);
}

constexpr char magic[8] = { 'R', 'I', 'G', 'S', 'M', 'I', 'T', 'H' };
constexpr uint8_t version = 1;
constexpr size_t head = sizeof (magic) + 1 + kCCBlockSizeAES128, tag = CC_SHA256_DIGEST_LENGTH;

inline bool isRigFile (const juce::MemoryBlock& data)
{
    return data.getSize() >= sizeof (magic) && std::memcmp (data.getData(), magic, sizeof (magic)) == 0;
}

inline juce::MemoryBlock seal (const juce::String& json)
{
    uint8_t enc[32], mac[32];
    keys (enc, mac);
    const auto* plain = json.toRawUTF8();
    const size_t plainLen = json.getNumBytesAsUTF8();

    juce::MemoryBlock out (head + plainLen + kCCBlockSizeAES128 + tag);
    auto* p = static_cast<uint8_t*> (out.getData());
    std::memcpy (p, magic, sizeof (magic));
    p[sizeof (magic)] = version;
    uint8_t* iv = p + sizeof (magic) + 1;
    arc4random_buf (iv, kCCBlockSizeAES128);

    size_t written = 0;
    if (CCCrypt (kCCEncrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, enc, sizeof enc, iv, plain, plainLen,
                 p + head, plainLen + kCCBlockSizeAES128, &written) != kCCSuccess)
        return {};
    CCHmac (kCCHmacAlgSHA256, mac, sizeof mac, p, head + written, p + head + written);
    out.setSize (head + written + tag);
    return out;
}

// The rig's JSON, or nothing when the file isn't ours, was cut short or was altered.
inline std::optional<juce::String> open (const juce::MemoryBlock& data)
{
    const auto* p = static_cast<const uint8_t*> (data.getData());
    const size_t size = data.getSize();
    if (! isRigFile (data) || size < head + kCCBlockSizeAES128 + tag || p[sizeof (magic)] != version)
        return std::nullopt;

    uint8_t enc[32], mac[32], expected[tag];
    keys (enc, mac);
    const size_t body = size - tag;
    CCHmac (kCCHmacAlgSHA256, mac, sizeof mac, p, body, expected);
    if (timingsafe_bcmp (expected, p + body, tag) != 0)
        return std::nullopt;

    juce::MemoryBlock plain (body - head);
    size_t written = 0;
    if (CCCrypt (kCCDecrypt, kCCAlgorithmAES, kCCOptionPKCS7Padding, enc, sizeof enc, p + sizeof (magic) + 1,
                 p + head, body - head, plain.getData(), plain.getSize(), &written) != kCCSuccess)
        return std::nullopt;
    return juce::String::fromUTF8 (static_cast<const char*> (plain.getData()), (int) written);
}
} // namespace rigfile
