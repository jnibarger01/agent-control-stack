#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <sys/types.h>

namespace jc::witness {

struct CgroupLeaf {
    std::string path;
    uint64_t cgroup_id{0};
    int dir_fd{-1};
    bool created_by_witness{false};
    bool cleaned_up{false};
};

std::string detect_delegated_cgroup_root(const std::string& override_root = "");

CgroupLeaf create_witness_cgroup_leaf(const std::string& root_path, const std::string& prefix = "jc-witness");

pid_t clone_into_cgroup(int cgroup_dir_fd, const std::function<int()>& child_fn);

void terminate_witness_cgroup_processes(const CgroupLeaf& leaf);

bool cleanup_witness_cgroup_leaf(CgroupLeaf& leaf);

} // namespace jc::witness
