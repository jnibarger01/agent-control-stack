#include "witness/signer.hpp"

#include <exception>
#include <iostream>
#include <string>

int main(int argc, char** argv) {
    try {
        if (argc >= 2 && std::string(argv[1]) == "key-admin") {
            return jc::witness::run_key_admin_cli(argc, argv, 2);
        }
        int start_idx = (argc >= 2 && std::string(argv[1]) == "serve") ? 2 : 1;
        return jc::witness::run_signerd_cli(argc, argv, start_idx);
    } catch (const std::exception& ex) {
        std::cerr << "jc-witness-signerd error: " << ex.what() << "\n";
        return 1;
    }
}
