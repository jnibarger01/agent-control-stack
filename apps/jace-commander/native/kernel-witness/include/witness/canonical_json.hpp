#pragma once

#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace jc::witness {

struct JsonValue;
using JsonArray = std::vector<JsonValue>;
using JsonObject = std::map<std::string, JsonValue>;

struct JsonValue {
    using Variant = std::variant<
        std::nullptr_t,
        bool,
        int64_t,
        uint64_t,
        double,
        std::string,
        JsonArray,
        JsonObject>;

    Variant data{nullptr};

    JsonValue() = default;
    JsonValue(std::nullptr_t) : data(nullptr) {}
    JsonValue(bool b) : data(b) {}
    JsonValue(int i) : data(static_cast<int64_t>(i)) {}
    JsonValue(int64_t i) : data(i) {}
    JsonValue(uint64_t u) : data(u) {}
    JsonValue(double d) : data(d) {}
    JsonValue(const char* s) : data(std::string(s)) {}
    JsonValue(std::string s) : data(std::move(s)) {}
    JsonValue(JsonArray a) : data(std::move(a)) {}
    JsonValue(JsonObject o) : data(std::move(o)) {}

    bool is_null() const { return std::holds_alternative<std::nullptr_t>(data); }
    bool is_bool() const { return std::holds_alternative<bool>(data); }
    bool is_int64() const { return std::holds_alternative<int64_t>(data); }
    bool is_uint64() const { return std::holds_alternative<uint64_t>(data); }
    bool is_double() const { return std::holds_alternative<double>(data); }
    bool is_number() const { return is_int64() || is_uint64() || is_double(); }
    bool is_string() const { return std::holds_alternative<std::string>(data); }
    bool is_array() const { return std::holds_alternative<JsonArray>(data); }
    bool is_object() const { return std::holds_alternative<JsonObject>(data); }

    const std::string& as_string() const;
    int64_t as_int64() const;
    uint64_t as_uint64() const;
    bool as_bool() const;
    const JsonArray& as_array() const;
    const JsonObject& as_object() const;
    JsonObject& as_object_mut();
};

std::string serialize_canonical_json(const JsonValue& value);
JsonValue parse_json(std::string_view input);

} // namespace jc::witness
