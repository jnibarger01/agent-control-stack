#include "witness/cgroup.hpp"

#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <linux/magic.h>
#include <linux/sched.h>
#include <random>
#include <sstream>
#include <stdexcept>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <vector>

#ifndef CLONE_INTO_CGROUP
#define CLONE_INTO_CGROUP 0x200000000ULL
#endif

#ifndef CGROUP2_SUPER_MAGIC
#define CGROUP2_SUPER_MAGIC 0x63677270
#endif

namespace jc::witness {

namespace {

std::string random_hex_suffix() {
    std::random_device rd;
    uint64_t val = (static_cast<uint64_t>(rd()) << 32) | static_cast<uint64_t>(rd());
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out(12, '0');
    for (int i = 11; i >= 0; --i) {
        out[static_cast<size_t>(i)] = kHex[val & 0xF];
        val >>= 4;
    }
    return out;
}

bool is_cgroup2_dir(const std::string& path) {
    struct statfs sfs{};
    if (statfs(path.c_str(), &sfs) != 0) return false;
    return static_cast<unsigned long>(sfs.f_type) == static_cast<unsigned long>(CGROUP2_SUPER_MAGIC);
}

bool can_create_child_cgroup(const std::string& dir) {
    if (access(dir.c_str(), W_OK | X_OK) != 0) return false;
    if (!is_cgroup2_dir(dir)) return false;
    std::string probe = dir + "/.jc-witness-probe-" + std::to_string(getpid()) + "-" + random_hex_suffix();
    if (mkdir(probe.c_str(), 0755) == 0) {
        rmdir(probe.c_str());
        return true;
    }
    return false;
}

} // namespace

std::string detect_delegated_cgroup_root(const std::string& override_root) {
    if (!override_root.empty()) {
        if (!is_cgroup2_dir(override_root) || access(override_root.c_str(), W_OK | X_OK) != 0) {
            throw std::runtime_error("specified cgroup root is not a writable cgroup v2 directory: " + override_root);
        }
        return override_root;
    }

    if (const char* env_root = std::getenv("JC_WITNESS_CGROUP_ROOT"); env_root && *env_root) {
        std::string r(env_root);
        if (!is_cgroup2_dir(r) || access(r.c_str(), W_OK | X_OK) != 0) {
            throw std::runtime_error("JC_WITNESS_CGROUP_ROOT is not a writable cgroup v2 directory: " + r);
        }
        return r;
    }

    std::ifstream cg("/proc/self/cgroup");
    if (!cg) {
        throw std::runtime_error("failed to read /proc/self/cgroup for cgroup v2 detection");
    }

    std::string rel_path;
    std::string line;
    while (std::getline(cg, line)) {
        if (line.rfind("0::", 0) == 0) {
            rel_path = line.substr(3);
            break;
        }
    }
    if (rel_path.empty()) {
        throw std::runtime_error("no cgroup v2 unified hierarchy entry (0::) found in /proc/self/cgroup");
    }

    std::string cur = "/sys/fs/cgroup" + rel_path;
    while (!cur.empty() && cur != "/sys/fs") {
        if (can_create_child_cgroup(cur)) {
            return cur;
        }
        auto slash = cur.rfind('/');
        if (slash == std::string::npos || slash == 0) break;
        cur = cur.substr(0, slash);
        if (cur == "/sys/fs/cgroup") {
            if (can_create_child_cgroup(cur)) return cur;
            break;
        }
    }

    throw std::runtime_error("no writable delegated cgroup v2 root found (set JC_WITNESS_CGROUP_ROOT or --cgroup-root)");
}

CgroupLeaf create_witness_cgroup_leaf(const std::string& root_path, const std::string& prefix) {
    if (!is_cgroup2_dir(root_path)) {
        throw std::runtime_error("cgroup root is not cgroup2fs: " + root_path);
    }

    std::string leaf_path = root_path;
    if (leaf_path.back() != '/') leaf_path.push_back('/');
    leaf_path += prefix + "-" + std::to_string(getpid()) + "-" + random_hex_suffix();

    if (mkdir(leaf_path.c_str(), 0755) != 0) {
        throw std::runtime_error("failed to create witness cgroup leaf " + leaf_path + ": " + std::strerror(errno));
    }

    int fd = open(leaf_path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) {
        int err = errno;
        rmdir(leaf_path.c_str());
        throw std::runtime_error("failed to open witness cgroup leaf " + leaf_path + ": " + std::strerror(err));
    }

    struct stat st{};
    if (fstat(fd, &st) != 0) {
        int err = errno;
        close(fd);
        rmdir(leaf_path.c_str());
        throw std::runtime_error(std::string("fstat failed on witness cgroup leaf: ") + std::strerror(err));
    }

    CgroupLeaf leaf;
    leaf.path = std::move(leaf_path);
    leaf.cgroup_id = static_cast<uint64_t>(st.st_ino);
    leaf.dir_fd = fd;
    leaf.created_by_witness = true;
    leaf.cleaned_up = false;
    return leaf;
}

pid_t clone_into_cgroup(int cgroup_dir_fd, const std::function<int()>& child_fn) {
    if (cgroup_dir_fd < 0) {
        throw std::runtime_error("invalid cgroup dirfd for CLONE_INTO_CGROUP");
    }

    struct clone_args cl_args{};
    cl_args.flags = CLONE_INTO_CGROUP;
    cl_args.exit_signal = SIGCHLD;
    cl_args.cgroup = static_cast<uint64_t>(cgroup_dir_fd);

    long rc = syscall(SYS_clone3, &cl_args, sizeof(cl_args));
    if (rc < 0) {
        throw std::runtime_error(std::string("clone3(CLONE_INTO_CGROUP) failed: ") + std::strerror(errno));
    }
    if (rc == 0) {
        int exit_code = 127;
        try {
            exit_code = child_fn();
        } catch (...) {
            exit_code = 126;
        }
        _exit(exit_code);
    }
    return static_cast<pid_t>(rc);
}

bool cleanup_witness_cgroup_leaf(CgroupLeaf& leaf) {
    if (!leaf.created_by_witness || leaf.path.empty()) {
        return true;
    }
    if (leaf.dir_fd >= 0) {
        close(leaf.dir_fd);
        leaf.dir_fd = -1;
    }

    // Attempt to kill any stragglers inside the cgroup before rmdir
    std::string kill_path = leaf.path + "/cgroup.kill";
    int kfd = open(kill_path.c_str(), O_WRONLY | O_CLOEXEC);
    if (kfd >= 0) {
        const char one = '1';
        [[maybe_unused]] ssize_t ignored = write(kfd, &one, 1);
        close(kfd);
    }

    // Retry rmdir briefly in case kernel is still draining exiting tasks
    for (int attempt = 0; attempt < 20; ++attempt) {
        if (rmdir(leaf.path.c_str()) == 0 || errno == ENOENT) {
            leaf.cleaned_up = true;
            return true;
        }
        if (errno != EBUSY) {
            break;
        }
        usleep(5000);
    }
    leaf.cleaned_up = false;
    return false;
}

} // namespace jc::witness
