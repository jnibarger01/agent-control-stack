#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace jc::witness {

std::string sha256_hex(std::string_view data);
std::string base64_encode(const std::vector<uint8_t>& data);
std::vector<uint8_t> base64_decode(std::string_view b64);

void generate_ed25519_keypair_pem(const std::string& private_pem_path, const std::string& public_pem_path);
std::pair<std::string, std::string> generate_ephemeral_ed25519_keypair_pem();

std::string ed25519_sign_pem(std::string_view message, const std::string& private_pem_or_path, bool is_path = true);
bool ed25519_verify_pem(std::string_view message, std::string_view signature_b64, const std::string& public_pem_or_path, bool is_path = true);

std::string derive_key_id_from_public_pem(const std::string& public_pem_or_path, bool is_path = true);
std::string derive_key_id_from_private_pem(const std::string& private_pem_or_path, bool is_path = true);

} // namespace jc::witness
