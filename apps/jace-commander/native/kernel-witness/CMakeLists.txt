cmake_minimum_required(VERSION 3.20)
project(jc_kernel_witness LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBBPF REQUIRED IMPORTED_TARGET libbpf)
pkg_check_modules(LIBCRYPTO REQUIRED IMPORTED_TARGET libcrypto)

find_program(CLANG_EXECUTABLE clang REQUIRED)
find_program(BPFTOOL_EXECUTABLE bpftool REQUIRED)

if(CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64")
    set(BPF_TARGET_ARCH "x86")
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
    set(BPF_TARGET_ARCH "arm64")
else()
    set(BPF_TARGET_ARCH "${CMAKE_SYSTEM_PROCESSOR}")
endif()

set(VMLINUX_H "${CMAKE_CURRENT_BINARY_DIR}/vmlinux.h")
set(WITNESS_BPF_SRC "${CMAKE_CURRENT_SOURCE_DIR}/bpf/witness.bpf.c")
set(WITNESS_BPF_OBJ "${CMAKE_CURRENT_BINARY_DIR}/witness.bpf.o")

add_custom_command(
    OUTPUT "${VMLINUX_H}"
    COMMAND bash -c "if [ -f /sys/kernel/btf/vmlinux ]; then '${BPFTOOL_EXECUTABLE}' btf dump file /sys/kernel/btf/vmlinux format c > '${VMLINUX_H}'; elif [ ! -f '${VMLINUX_H}' ]; then echo 'Missing /sys/kernel/btf/vmlinux and no cached vmlinux.h' >&2; exit 1; fi"
    COMMENT "Generating vmlinux.h from kernel BTF"
    VERBATIM
)

add_custom_command(
    OUTPUT "${WITNESS_BPF_OBJ}"
    COMMAND "${CLANG_EXECUTABLE}"
        -g -O2 -target bpf
        "-D__TARGET_ARCH_${BPF_TARGET_ARCH}"
        "-I${CMAKE_CURRENT_BINARY_DIR}"
        "-I${CMAKE_CURRENT_SOURCE_DIR}/bpf"
        -c "${WITNESS_BPF_SRC}"
        -o "${WITNESS_BPF_OBJ}"
    DEPENDS "${VMLINUX_H}" "${WITNESS_BPF_SRC}" "${CMAKE_CURRENT_SOURCE_DIR}/bpf/witness_event.h"
    COMMENT "Compiling CO-RE eBPF program witness.bpf.c"
    VERBATIM
)

add_custom_target(witness_bpf_obj ALL DEPENDS "${WITNESS_BPF_OBJ}")

add_library(jc_witness_core STATIC
    src/canonical_json.cpp
    src/crypto.cpp
    src/cgroup.cpp
    src/process_tree.cpp
    src/receipt.cpp
    src/signer.cpp
    src/observer.cpp
)

target_include_directories(jc_witness_core PUBLIC
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/bpf"
)

target_compile_options(jc_witness_core PRIVATE -Wall -Wextra -Wpedantic)
target_link_libraries(jc_witness_core PUBLIC
    PkgConfig::LIBBPF
    PkgConfig::LIBCRYPTO
)

add_executable(jc-kernel-witness src/main.cpp)
add_dependencies(jc-kernel-witness witness_bpf_obj)
target_link_libraries(jc-kernel-witness PRIVATE jc_witness_core)
target_compile_options(jc-kernel-witness PRIVATE -Wall -Wextra -Wpedantic)

add_executable(jc-witness-signerd src/signerd_main.cpp)
target_link_libraries(jc-witness-signerd PRIVATE jc_witness_core)
target_compile_options(jc-witness-signerd PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
add_executable(jc_witness_tests tests/test_witness.cpp)
add_dependencies(jc_witness_tests witness_bpf_obj)
target_link_libraries(jc_witness_tests PRIVATE jc_witness_core)
target_compile_options(jc_witness_tests PRIVATE -Wall -Wextra -Wpedantic)

add_test(NAME jc_witness_tests COMMAND jc_witness_tests)
set_tests_properties(jc_witness_tests PROPERTIES
    ENVIRONMENT "JC_WITNESS_TEST_BPF_OBJ=${WITNESS_BPF_OBJ}"
)
