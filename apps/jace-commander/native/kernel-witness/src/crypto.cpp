#include "witness/crypto.hpp"

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/pem.h>
#include <openssl/x509.h>

#include <array>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <fcntl.h>
#include <fstream>
#include <iomanip>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

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

std::string bytes_to_hex(const unsigned char* data, size_t len) {
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        out.push_back(kHex[(data[i] >> 4) & 0xF]);
        out.push_back(kHex[data[i] & 0xF]);
    }
    return out;
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
    return bytes_to_hex(digest.data(), len);
}

std::string hmac_sha256_hex(std::string_view key, std::string_view data) {
    std::array<unsigned char, EVP_MAX_MD_SIZE> digest{};
    unsigned int len = 0;
    const unsigned char* res = HMAC(
        EVP_sha256(),
        key.data(),
        static_cast<int>(key.size()),
        reinterpret_cast<const unsigned char*>(data.data()),
        data.size(),
        digest.data(),
        &len);
    if (!res || len == 0) {
        throw std::runtime_error("HMAC-SHA256 computation failed");
    }
    return bytes_to_hex(digest.data(), len);
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
        int fd = open(private_pem_path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
        if (fd < 0) {
            throw std::runtime_error("failed to create private key: " + private_pem_path);
        }
        if (fchmod(fd, 0600) != 0) {
            close(fd);
            throw std::runtime_error("failed to chmod 0600 private key: " + private_pem_path);
        }
        size_t total = 0;
        while (total < priv_pem.size()) {
            ssize_t n = write(fd, priv_pem.data() + total, priv_pem.size() - total);
            if (n <= 0) {
                close(fd);
                throw std::runtime_error("failed to write private key: " + private_pem_path);
            }
            total += static_cast<size_t>(n);
        }
        close(fd);
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

std::string derive_public_pem_from_private_pem(const std::string& private_pem_or_path, bool is_path) {
    EvpPkeyPtr pkey = load_private_key(private_pem_or_path, is_path);
    BioPtr pub_bio(BIO_new(BIO_s_mem()));
    if (!pub_bio) throw std::runtime_error("BIO_new failed");
    if (PEM_write_bio_PUBKEY(pub_bio.get(), pkey.get()) != 1) {
        throw std::runtime_error("PEM_write_bio_PUBKEY failed");
    }
    BUF_MEM* pub_mem = nullptr;
    BIO_get_mem_ptr(pub_bio.get(), &pub_mem);
    return std::string(pub_mem->data, pub_mem->length);
}

std::string sanitize_utf8(std::string_view input, size_t max_bytes) {
    std::string out;
    out.reserve(input.size());
    size_t i = 0;
    const size_t n = input.size();
    while (i < n) {
        unsigned char c0 = static_cast<unsigned char>(input[i]);
        if (c0 == '\0') break;
        size_t seq_len = 0;
        if (c0 < 0x80) {
            seq_len = 1;
        } else if ((c0 & 0xE0) == 0xC0) {
            if (i + 1 < n) {
                unsigned char c1 = static_cast<unsigned char>(input[i + 1]);
                uint32_t cp = ((c0 & 0x1Fu) << 6) | (c1 & 0x3Fu);
                if ((c1 & 0xC0) == 0x80 && cp >= 0x80) seq_len = 2;
            }
        } else if ((c0 & 0xF0) == 0xE0) {
            if (i + 2 < n) {
                unsigned char c1 = static_cast<unsigned char>(input[i + 1]);
                unsigned char c2 = static_cast<unsigned char>(input[i + 2]);
                uint32_t cp = ((c0 & 0x0Fu) << 12) | ((c1 & 0x3Fu) << 6) | (c2 & 0x3Fu);
                if ((c1 & 0xC0) == 0x80 && (c2 & 0xC0) == 0x80 && cp >= 0x800 && (cp < 0xD800 || cp > 0xDFFF)) {
                    seq_len = 3;
                }
            }
        } else if ((c0 & 0xF8) == 0xF0) {
            if (i + 3 < n) {
                unsigned char c1 = static_cast<unsigned char>(input[i + 1]);
                unsigned char c2 = static_cast<unsigned char>(input[i + 2]);
                unsigned char c3 = static_cast<unsigned char>(input[i + 3]);
                uint32_t cp = ((c0 & 0x07u) << 18) | ((c1 & 0x3Fu) << 12) | ((c2 & 0x3Fu) << 6) | (c3 & 0x3Fu);
                if ((c1 & 0xC0) == 0x80 && (c2 & 0xC0) == 0x80 && (c3 & 0xC0) == 0x80 && cp >= 0x10000 && cp <= 0x10FFFF) {
                    seq_len = 4;
                }
            }
        }

        if (seq_len > 0) {
            if (max_bytes > 0 && out.size() + seq_len > max_bytes) break;
            out.append(input.data() + i, seq_len);
            i += seq_len;
        } else {
            if (max_bytes > 0 && out.size() + 1 > max_bytes) break;
            out.push_back('?');
            ++i;
        }
    }
    return out;
}

std::string current_utc_iso8601() {
    auto now = std::chrono::system_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
    std::time_t secs = static_cast<std::time_t>(ms / 1000);
    int rem_ms = static_cast<int>(ms % 1000);
    if (rem_ms < 0) rem_ms += 1000;
    struct tm tm_utc{};
    gmtime_r(&secs, &tm_utc);
    char buf[64]{};
    std::snprintf(
        buf, sizeof(buf),
        "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
        tm_utc.tm_year + 1900,
        tm_utc.tm_mon + 1,
        tm_utc.tm_mday,
        tm_utc.tm_hour,
        tm_utc.tm_min,
        tm_utc.tm_sec,
        rem_ms);
    return std::string(buf);
}

std::optional<int64_t> parse_utc_iso8601_epoch_ms(std::string_view iso) {
    if (iso.size() < 20 || iso.back() != 'Z') return std::nullopt;
    int year = 0, mon = 0, day = 0, hour = 0, min = 0, sec = 0, ms = 0;
    std::string s(iso);
    int matched = std::sscanf(
        s.c_str(), "%04d-%02d-%02dT%02d:%02d:%02d.%dZ",
        &year, &mon, &day, &hour, &min, &sec, &ms);
    if (matched < 6) return std::nullopt;
    if (matched == 6) {
        if (std::sscanf(s.c_str(), "%04d-%02d-%02dT%02d:%02d:%02dZ", &year, &mon, &day, &hour, &min, &sec) != 6) {
            return std::nullopt;
        }
        ms = 0;
    } else {
        auto dot = s.find('.');
        auto z = s.find('Z', dot);
        if (dot != std::string::npos && z != std::string::npos) {
            size_t digits = z - dot - 1;
            if (digits == 1) ms *= 100;
            else if (digits == 2) ms *= 10;
            else if (digits > 3) {
                while (digits > 3) { ms /= 10; --digits; }
            }
        }
    }

    struct tm tm_utc{};
    tm_utc.tm_year = year - 1900;
    tm_utc.tm_mon = mon - 1;
    tm_utc.tm_mday = day;
    tm_utc.tm_hour = hour;
    tm_utc.tm_min = min;
    tm_utc.tm_sec = sec;
    time_t epoch_sec = timegm(&tm_utc);
    if (epoch_sec == static_cast<time_t>(-1)) return std::nullopt;
    return static_cast<int64_t>(epoch_sec) * 1000 + static_cast<int64_t>(ms);
}

} // namespace jc::witness
