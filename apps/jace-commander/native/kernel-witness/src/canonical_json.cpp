#include "witness/canonical_json.hpp"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>

namespace jc::witness {

const std::string& JsonValue::as_string() const {
    if (!is_string()) throw std::runtime_error("JSON value is not a string");
    return std::get<std::string>(data);
}

int64_t JsonValue::as_int64() const {
    if (is_int64()) return std::get<int64_t>(data);
    if (is_uint64()) {
        uint64_t u = std::get<uint64_t>(data);
        if (u <= static_cast<uint64_t>(INT64_MAX)) return static_cast<int64_t>(u);
    }
    throw std::runtime_error("JSON value is not a signed 64-bit integer");
}

uint64_t JsonValue::as_uint64() const {
    if (is_uint64()) return std::get<uint64_t>(data);
    if (is_int64()) {
        int64_t i = std::get<int64_t>(data);
        if (i >= 0) return static_cast<uint64_t>(i);
    }
    throw std::runtime_error("JSON value is not an unsigned 64-bit integer");
}

bool JsonValue::as_bool() const {
    if (!is_bool()) throw std::runtime_error("JSON value is not a bool");
    return std::get<bool>(data);
}

const JsonArray& JsonValue::as_array() const {
    if (!is_array()) throw std::runtime_error("JSON value is not an array");
    return std::get<JsonArray>(data);
}

const JsonObject& JsonValue::as_object() const {
    if (!is_object()) throw std::runtime_error("JSON value is not an object");
    return std::get<JsonObject>(data);
}

JsonObject& JsonValue::as_object_mut() {
    if (!is_object()) throw std::runtime_error("JSON value is not an object");
    return std::get<JsonObject>(data);
}

namespace {

void append_escaped_string(std::string& out, std::string_view s) {
    out.push_back('"');
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[7];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", static_cast<unsigned int>(c));
                    out += buf;
                } else {
                    out.push_back(static_cast<char>(c));
                }
                break;
        }
    }
    out.push_back('"');
}

void serialize_into(std::string& out, const JsonValue& v) {
    if (v.is_null()) {
        out += "null";
    } else if (v.is_bool()) {
        out += v.as_bool() ? "true" : "false";
    } else if (v.is_int64()) {
        out += std::to_string(std::get<int64_t>(v.data));
    } else if (v.is_uint64()) {
        out += std::to_string(std::get<uint64_t>(v.data));
    } else if (v.is_double()) {
        double d = std::get<double>(v.data);
        if (!std::isfinite(d)) {
            throw std::runtime_error("canonical JSON requires finite numbers");
        }
        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.17g", d);
        out += buf;
    } else if (v.is_string()) {
        append_escaped_string(out, v.as_string());
    } else if (v.is_array()) {
        out.push_back('[');
        const auto& arr = v.as_array();
        for (size_t i = 0; i < arr.size(); ++i) {
            if (i > 0) out.push_back(',');
            serialize_into(out, arr[i]);
        }
        out.push_back(']');
    } else if (v.is_object()) {
        out.push_back('{');
        const auto& obj = v.as_object(); // std::map is already sorted by key
        bool first = true;
        for (const auto& [k, val] : obj) {
            if (!first) out.push_back(',');
            first = false;
            append_escaped_string(out, k);
            out.push_back(':');
            serialize_into(out, val);
        }
        out.push_back('}');
    }
}

class JsonParser {
public:
    explicit JsonParser(std::string_view input) : s_(input), pos_(0) {}

    JsonValue parse_root() {
        skip_ws();
        JsonValue v = parse_value();
        skip_ws();
        if (pos_ != s_.size()) {
            throw std::runtime_error("unexpected trailing characters in JSON");
        }
        return v;
    }

private:
    std::string_view s_;
    size_t pos_;

    void skip_ws() {
        while (pos_ < s_.size() && (s_[pos_] == ' ' || s_[pos_] == '\t' || s_[pos_] == '\n' || s_[pos_] == '\r')) {
            ++pos_;
        }
    }

    char peek() const {
        if (pos_ >= s_.size()) throw std::runtime_error("unexpected end of JSON input");
        return s_[pos_];
    }

    char get() {
        char c = peek();
        ++pos_;
        return c;
    }

    JsonValue parse_value() {
        skip_ws();
        char c = peek();
        if (c == 'n') return parse_null();
        if (c == 't' || c == 'f') return parse_bool();
        if (c == '"') return JsonValue(parse_string());
        if (c == '[') return parse_array();
        if (c == '{') return parse_object();
        if (c == '-' || (c >= '0' && c <= '9')) return parse_number();
        throw std::runtime_error("unexpected character in JSON");
    }

    JsonValue parse_null() {
        if (s_.substr(pos_, 4) == "null") {
            pos_ += 4;
            return JsonValue(nullptr);
        }
        throw std::runtime_error("invalid literal in JSON");
    }

    JsonValue parse_bool() {
        if (s_.substr(pos_, 4) == "true") {
            pos_ += 4;
            return JsonValue(true);
        }
        if (s_.substr(pos_, 5) == "false") {
            pos_ += 5;
            return JsonValue(false);
        }
        throw std::runtime_error("invalid boolean in JSON");
    }

    static uint32_t hex_digit(char c) {
        if (c >= '0' && c <= '9') return static_cast<uint32_t>(c - '0');
        if (c >= 'a' && c <= 'f') return static_cast<uint32_t>(c - 'a' + 10);
        if (c >= 'A' && c <= 'F') return static_cast<uint32_t>(c - 'A' + 10);
        throw std::runtime_error("invalid hex digit in \\u escape");
    }

    uint32_t parse_hex4() {
        if (pos_ + 4 > s_.size()) throw std::runtime_error("truncated \\u escape");
        uint32_t v = 0;
        for (int i = 0; i < 4; ++i) {
            v = (v << 4) | hex_digit(s_[pos_++]);
        }
        return v;
    }

    static void append_utf8(std::string& out, uint32_t cp) {
        if (cp <= 0x7F) {
            out.push_back(static_cast<char>(cp));
        } else if (cp <= 0x7FF) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp <= 0xFFFF) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    std::string parse_string() {
        if (get() != '"') throw std::runtime_error("expected '\"'");
        std::string out;
        while (true) {
            char c = get();
            if (c == '"') break;
            if (static_cast<unsigned char>(c) < 0x20) {
                throw std::runtime_error("unescaped control character in JSON string");
            }
            if (c == '\\') {
                char esc = get();
                switch (esc) {
                    case '"': out.push_back('"'); break;
                    case '\\': out.push_back('\\'); break;
                    case '/': out.push_back('/'); break;
                    case 'b': out.push_back('\b'); break;
                    case 'f': out.push_back('\f'); break;
                    case 'n': out.push_back('\n'); break;
                    case 'r': out.push_back('\r'); break;
                    case 't': out.push_back('\t'); break;
                    case 'u': {
                        uint32_t cp = parse_hex4();
                        if (cp >= 0xD800 && cp <= 0xDBFF && pos_ + 2 <= s_.size() && s_[pos_] == '\\' && s_[pos_ + 1] == 'u') {
                            pos_ += 2;
                            uint32_t low = parse_hex4();
                            if (low >= 0xDC00 && low <= 0xDFFF) {
                                cp = 0x10000 + (((cp - 0xD800) << 10) | (low - 0xDC00));
                            }
                        }
                        append_utf8(out, cp);
                        break;
                    }
                    default:
                        throw std::runtime_error("invalid escape sequence in JSON string");
                }
            } else {
                out.push_back(c);
            }
        }
        return out;
    }

    JsonValue parse_number() {
        size_t start = pos_;
        bool is_neg = false;
        bool is_float = false;
        if (s_[pos_] == '-') {
            is_neg = true;
            ++pos_;
        }
        if (pos_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[pos_]))) {
            throw std::runtime_error("invalid number in JSON");
        }
        if (s_[pos_] == '0') {
            ++pos_;
        } else {
            while (pos_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[pos_]))) ++pos_;
        }
        if (pos_ < s_.size() && s_[pos_] == '.') {
            is_float = true;
            ++pos_;
            if (pos_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[pos_]))) {
                throw std::runtime_error("invalid fraction in JSON number");
            }
            while (pos_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[pos_]))) ++pos_;
        }
        if (pos_ < s_.size() && (s_[pos_] == 'e' || s_[pos_] == 'E')) {
            is_float = true;
            ++pos_;
            if (pos_ < s_.size() && (s_[pos_] == '+' || s_[pos_] == '-')) ++pos_;
            if (pos_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[pos_]))) {
                throw std::runtime_error("invalid exponent in JSON number");
            }
            while (pos_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[pos_]))) ++pos_;
        }

        std::string num_str(s_.substr(start, pos_ - start));
        if (is_float) {
            char* endp = nullptr;
            double d = std::strtod(num_str.c_str(), &endp);
            if (endp != num_str.c_str() + num_str.size() || !std::isfinite(d)) {
                throw std::runtime_error("invalid floating point JSON number");
            }
            return JsonValue(d);
        }
        if (is_neg) {
            char* endp = nullptr;
            long long v = std::strtoll(num_str.c_str(), &endp, 10);
            if (endp != num_str.c_str() + num_str.size()) {
                throw std::runtime_error("invalid signed integer in JSON");
            }
            return JsonValue(static_cast<int64_t>(v));
        } else {
            char* endp = nullptr;
            unsigned long long u = std::strtoull(num_str.c_str(), &endp, 10);
            if (endp != num_str.c_str() + num_str.size()) {
                throw std::runtime_error("invalid unsigned integer in JSON");
            }
            return JsonValue(static_cast<uint64_t>(u));
        }
    }

    JsonValue parse_array() {
        if (get() != '[') throw std::runtime_error("expected '['");
        JsonArray arr;
        skip_ws();
        if (peek() == ']') {
            get();
            return JsonValue(std::move(arr));
        }
        while (true) {
            arr.push_back(parse_value());
            skip_ws();
            char c = get();
            if (c == ']') break;
            if (c != ',') throw std::runtime_error("expected ',' or ']' in JSON array");
        }
        return JsonValue(std::move(arr));
    }

    JsonValue parse_object() {
        if (get() != '{') throw std::runtime_error("expected '{'");
        JsonObject obj;
        skip_ws();
        if (peek() == '}') {
            get();
            return JsonValue(std::move(obj));
        }
        while (true) {
            skip_ws();
            std::string key = parse_string();
            skip_ws();
            if (get() != ':') throw std::runtime_error("expected ':' in JSON object");
            obj[std::move(key)] = parse_value();
            skip_ws();
            char c = get();
            if (c == '}') break;
            if (c != ',') throw std::runtime_error("expected ',' or '}' in JSON object");
        }
        return JsonValue(std::move(obj));
    }
};

} // namespace

std::string serialize_canonical_json(const JsonValue& value) {
    std::string out;
    out.reserve(256);
    serialize_into(out, value);
    return out;
}

JsonValue parse_json(std::string_view input) {
    JsonParser parser(input);
    return parser.parse_root();
}

} // namespace jc::witness
