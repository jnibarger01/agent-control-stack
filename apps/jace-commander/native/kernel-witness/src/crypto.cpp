#include "witness/crypto.hpp"

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/x509.h>

#include <array>
#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <stdexcept>

namespace jc::witness {

namespace {

struct BioDeleter { void operator()(BIO* b) const { BIO_free_all(b); } };
struct EvpPkeyDeleter { void operator()(EVP_PKEY* p) const { EVP_PKEY_free(p); } };
struct EvpPkeyCtxDeleter { void operator()(EVP_PKEY_CTX* c) const { EVP_PKEY_CTX_free(c); } };
struct EvpMdCtxDeleter { void operator()(EVP_MD_CTX* c) const { EVP_MD_CTX_free(c); } };

using BioPtr = std::unique_ptr<BIO, BioDeleter>;
using EvpPkeyPtr = std::unique_ptr<EVP_PKEY, EvpPkeyDeleter>;
using EvpPkeyCtxPtr = std::unique_ptr<EVP_PKEY_CTX, EvpPkeyCtxDeleter>;
using EvpMdCtxPtr = std::unique_ptr<EVP_MD_CTX, EvpMdCtxDeleter>;

std::string read_file_text(const std::string& path) {
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) throw std::runtime_error("failed to open PEM file: " + path);
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return oss.str();
}

EvpPkeyPtr load_private_key(const std::string& pem_or_path, bool is_path) {
    std::string pem = is_path ? read_file_text(pem_or_path) : pem_or_path;
    BioPtr bio(BIO_new_mem_buf(pem.data(), static_cast<int>(pem.size())));
    if (!bio) throw std::runtime_error("BIO_new_mem_buf failed");
    EvpPkeyPtr pkey(PEM_read_bio_PrivateKey(bio.get(), nullptr, nullptr, nullptr));
    if (!pkey) throw std::runtime_error("failed to parse Ed25519 private key PEM");
    if (EVP_PKEY_id(pkey.get()) != EVP_PKEY_ED25519) {
        throw std::runtime_error("private key is not Ed25519");
    }
    return pkey;
}

EvpPkeyPtr load_public_key(const std::string& pem_or_path, bool is_path) {
    std::string pem = is_path ? read_file_text(pem_or_path) : pem_or_path;
    BioPtr bio(BIO_new_mem_buf(pem.data(), static_cast<int>(pem.size())));
    if (!bio) throw std::runtime_error("BIO_new_mem_buf failed");
    EvpPkeyPtr pkey(PEM_read_bio_PUBKEY(bio.get(), nullptr, nullptr, nullptr));
    if (!pkey) throw std::runtime_error("failed to parse Ed25519 public key PEM");
    if (EVP_PKEY_id(pkey.get()) != EVP_PKEY_ED25519) {
        throw std::runtime_error("public key is not Ed25519");
    }
    return pkey;
}

std::string key_id_from_evp_pkey(EVP_PKEY* pkey) {
    int der_len = i2d_PUBKEY(pkey, nullptr);
    if (der_len <= 0) throw std::runtime_error("i2d_PUBKEY length failed");
    std::vector<unsigned char> der(static_cast<size_t>(der_len));
    unsigned char* p = der.data();
    if (i2d_PUBKEY(pkey, &p) != der_len) throw std::runtime_error("i2d_PUBKEY encode failed");
    std::string hex = sha256_hex(std::string_view(reinterpret_cast<const char*>(der.data()), der.size()));
    return "ed25519:" + hex.substr(0, 16);
}

} // namespace

std::string sha256_hex(std::string_view data) {
    EvpMdCtxPtr ctx(EVP_MD_CTX_new());
    if (!ctx) throw std::runtime_error("EVP_MD_CTX_new failed");
    if (EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) != 1) {
        throw std::runtime_error("EVP_DigestInit_ex failed");
    }
    if (!data.empty() && EVP_DigestUpdate(ctx.get(), data.data(), data.size()) != 1) {
        throw std::runtime_error("EVP_DigestUpdate failed");
    }
    std::array<unsigned char, EVP_MAX_MD_SIZE> digest{};
    unsigned int len = 0;
    if (EVP_DigestFinal_ex(ctx.get(), digest.data(), &len) != 1) {
        throw std::runtime_error("EVP_DigestFinal_ex failed");
    }
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (unsigned int i = 0; i < len; ++i) {
        out.push_back(kHex[(digest[i] >> 4) & 0xF]);
        out.push_back(kHex[digest[i] & 0xF]);
    }
    return out;
}

std::string base64_encode(const std::vector<uint8_t>& data) {
    if (data.empty()) return {};
    size_t out_len = 4 * ((data.size() + 2) / 3);
    std::string out(out_len, '\0');
    int written = EVP_EncodeBlock(
        reinterpret_cast<unsigned char*>(out.data()),
        data.data(),
        static_cast<int>(data.size()));
    if (written < 0) throw std::runtime_error("EVP_EncodeBlock failed");
    out.resize(static_cast<size_t>(written));
    return out;
}

std::vector<uint8_t> base64_decode(std::string_view b64) {
    if (b64.empty()) return {};
    if (b64.size() % 4 != 0) {
        throw std::runtime_error("invalid base64 length");
    }
    auto decode_char = [](unsigned char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };

    std::vector<uint8_t> out;
    out.reserve((b64.size() / 4) * 3);
    for (size_t i = 0; i < b64.size(); i += 4) {
        char c0 = b64[i], c1 = b64[i + 1], c2 = b64[i + 2], c3 = b64[i + 3];
        int v0 = decode_char(static_cast<unsigned char>(c0));
        int v1 = decode_char(static_cast<unsigned char>(c1));
        if (v0 < 0 || v1 < 0) throw std::runtime_error("invalid base64 character");

        bool pad2 = (c2 == '=');
        bool pad3 = (c3 == '=');
        if (pad2 && !pad3) throw std::runtime_error("invalid base64 padding");
        if ((pad2 || pad3) && (i + 4 != b64.size())) throw std::runtime_error("base64 padding before end");

        int v2 = pad2 ? 0 : decode_char(static_cast<unsigned char>(c2));
        int v3 = pad3 ? 0 : decode_char(static_cast<unsigned char>(c3));
        if ((!pad2 && v2 < 0) || (!pad3 && v3 < 0)) {
            throw std::runtime_error("invalid base64 character");
        }

        uint32_t triple = (static_cast<uint32_t>(v0) << 18) |
                          (static_cast<uint32_t>(v1) << 12) |
                          (static_cast<uint32_t>(v2) << 6) |
                          static_cast<uint32_t>(v3);
        out.push_back(static_cast<uint8_t>((triple >> 16) & 0xFF));
        if (!pad2) out.push_back(static_cast<uint8_t>((triple >> 8) & 0xFF));
        if (!pad3) out.push_back(static_cast<uint8_t>(triple & 0xFF));
    }
    return out;
}

std::pair<std::string, std::string> generate_ephemeral_ed25519_keypair_pem() {
    EvpPkeyCtxPtr pctx(EVP_PKEY_CTX_new_id(EVP_PKEY_ED25519, nullptr));
    if (!pctx) throw std::runtime_error("EVP_PKEY_CTX_new_id failed");
    if (EVP_PKEY_keygen_init(pctx.get()) <= 0) throw std::runtime_error("EVP_PKEY_keygen_init failed");
    EVP_PKEY* raw_pkey = nullptr;
    if (EVP_PKEY_keygen(pctx.get(), &raw_pkey) <= 0) throw std::runtime_error("EVP_PKEY_keygen failed");
    EvpPkeyPtr pkey(raw_pkey);

    BioPtr priv_bio(BIO_new(BIO_s_mem()));
    BioPtr pub_bio(BIO_new(BIO_s_mem()));
    if (!priv_bio || !pub_bio) throw std::runtime_error("BIO_new failed");

    if (PEM_write_bio_PrivateKey(priv_bio.get(), pkey.get(), nullptr, nullptr, 0, nullptr, nullptr) != 1) {
        throw std::runtime_error("PEM_write_bio_PrivateKey failed");
    }
    if (PEM_write_bio_PUBKEY(pub_bio.get(), pkey.get()) != 1) {
        throw std::runtime_error("PEM_write_bio_PUBKEY failed");
    }

    BUF_MEM* priv_mem = nullptr;
    BUF_MEM* pub_mem = nullptr;
    BIO_get_mem_ptr(priv_bio.get(), &priv_mem);
    BIO_get_mem_ptr(pub_bio.get(), &pub_mem);

    return {
        std::string(priv_mem->data, priv_mem->length),
        std::string(pub_mem->data, pub_mem->length)
    };
}

void generate_ed25519_keypair_pem(const std::string& private_pem_path, const std::string& public_pem_path) {
    auto [priv_pem, pub_pem] = generate_ephemeral_ed25519_keypair_pem();
    {
        std::ofstream ofs(private_pem_path, std::ios::binary | std::ios::trunc);
        if (!ofs) throw std::runtime_error("failed to write private key: " + private_pem_path);
        ofs << priv_pem;
    }
    {
        std::ofstream ofs(public_pem_path, std::ios::binary | std::ios::trunc);
        if (!ofs) throw std::runtime_error("failed to write public key: " + public_pem_path);
        ofs << pub_pem;
    }
}

std::string ed25519_sign_pem(std::string_view message, const std::string& private_pem_or_path, bool is_path) {
    EvpPkeyPtr pkey = load_private_key(private_pem_or_path, is_path);
    EvpMdCtxPtr ctx(EVP_MD_CTX_new());
    if (!ctx) throw std::runtime_error("EVP_MD_CTX_new failed");

    if (EVP_DigestSignInit(ctx.get(), nullptr, nullptr, nullptr, pkey.get()) != 1) {
        throw std::runtime_error("EVP_DigestSignInit failed");
    }
    size_t sig_len = 0;
    if (EVP_DigestSign(ctx.get(), nullptr, &sig_len,
                       reinterpret_cast<const unsigned char*>(message.data()), message.size()) != 1) {
        throw std::runtime_error("EVP_DigestSign size failed");
    }
    std::vector<uint8_t> sig(sig_len);
    if (EVP_DigestSign(ctx.get(), sig.data(), &sig_len,
                       reinterpret_cast<const unsigned char*>(message.data()), message.size()) != 1) {
        throw std::runtime_error("EVP_DigestSign failed");
    }
    sig.resize(sig_len);
    return base64_encode(sig);
}

bool ed25519_verify_pem(std::string_view message, std::string_view signature_b64, const std::string& public_pem_or_path, bool is_path) {
    std::vector<uint8_t> sig;
    try {
        sig = base64_decode(signature_b64);
    } catch (...) {
        return false;
    }
    if (sig.size() != 64) return false;

    EvpPkeyPtr pkey = load_public_key(public_pem_or_path, is_path);
    EvpMdCtxPtr ctx(EVP_MD_CTX_new());
    if (!ctx) return false;

    if (EVP_DigestVerifyInit(ctx.get(), nullptr, nullptr, nullptr, pkey.get()) != 1) {
        return false;
    }
    int rc = EVP_DigestVerify(
        ctx.get(),
        sig.data(),
        sig.size(),
        reinterpret_cast<const unsigned char*>(message.data()),
        message.size());
    return rc == 1;
}

std::string derive_key_id_from_public_pem(const std::string& public_pem_or_path, bool is_path) {
    EvpPkeyPtr pkey = load_public_key(public_pem_or_path, is_path);
    return key_id_from_evp_pkey(pkey.get());
}

std::string derive_key_id_from_private_pem(const std::string& private_pem_or_path, bool is_path) {
    EvpPkeyPtr pkey = load_private_key(private_pem_or_path, is_path);
    return key_id_from_evp_pkey(pkey.get());
}

} // namespace jc::witness
