//! The graph kernel. Input rows retain source order and string IDs preserve JS equality.
#![forbid(unsafe_code)]

use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet};

use crate::{DependencyAnalysis, Overlap};

pub fn analyze_dependencies(
    numbers: &[i64],
    heads: &[u32],
    bases: &[u32],
    target: u32,
) -> DependencyAnalysis {
    let len = numbers.len();
    let mut by_head = HashMap::<_, Vec<usize>>::new();
    for (row, &head) in heads.iter().enumerate() {
        // Zero marks a head outside the base repository.
        if head != 0 {
            by_head.entry(head).or_default().push(row);
        }
    }
    let mut parents = vec![Vec::new(); len];
    let mut children = vec![Vec::new(); len];
    let mut detached_seeds = Vec::new();
    for (row, &base) in bases.iter().enumerate() {
        if base == target {
            continue;
        }
        if let Some(matches) = by_head.get(&base) {
            parents[row].extend(matches.iter().copied().filter(|&parent| parent != row));
            parents[row].sort_unstable_by_key(|&parent| numbers[parent]);
            for &parent in &parents[row] {
                children[parent].push(row);
            }
        }
        if parents[row].is_empty() {
            detached_seeds.push(row);
        }
    }

    let (detached, is_detached) = spread(&detached_seeds, vec![false; len], &children);
    let mut roots = (0..len)
        .filter(|&row| !is_detached[row])
        .collect::<Vec<_>>();
    roots.sort_unstable_by_key(|&row| numbers[row]);
    let cyclic = cycles(&roots, &parents);
    let (blocked_and_cyclic, excluded) = spread(&cyclic, is_detached, &children);
    let mut waits = parents.iter().map(Vec::len).collect::<Vec<_>>();
    let mut ready = BinaryHeap::new();
    for &row in &roots {
        if !excluded[row] && waits[row] == 0 {
            ready.push(Reverse((numbers[row], row)));
        }
    }
    let mut order = Vec::new();
    while let Some(Reverse((number, row))) = ready.pop() {
        order.push(number);
        for &child in &children[row] {
            if !excluded[child] {
                waits[child] -= 1;
                if waits[child] == 0 {
                    ready.push(Reverse((numbers[child], child)));
                }
            }
        }
    }
    let row_numbers = |rows: &[usize]| rows.iter().map(|&row| numbers[row]).collect();
    DependencyAnalysis {
        parents: parents.iter().map(|rows| row_numbers(rows)).collect(),
        cyclic: row_numbers(&cyclic),
        blocked_by_cycle: row_numbers(&blocked_and_cyclic[cyclic.len()..]),
        detached: row_numbers(&detached),
        order,
    }
}

/// Preserve insertion order from the TS fixed-point scans. A lookup at an earlier
/// input row observes this discovery on the next pass. Seeds are visible before pass zero.
fn spread(
    seeds: &[usize],
    mut reached: Vec<bool>,
    children: &[Vec<usize>],
) -> (Vec<usize>, Vec<bool>) {
    let mut discovered = seeds.to_vec();
    let mut pending = BinaryHeap::new();
    for &row in seeds {
        reached[row] = true;
        pending.extend(children[row].iter().map(|&child| Reverse((0, child))));
    }
    while let Some(Reverse((pass, row))) = pending.pop() {
        if std::mem::replace(&mut reached[row], true) {
            continue;
        }
        discovered.push(row);
        for &child in &children[row] {
            if !reached[child] {
                pending.push(Reverse((pass + usize::from(child < row), child)));
            }
        }
    }
    (discovered, reached)
}

/// Tarjan DFS with explicit frames. Match the TS traversal and component pop order.
fn cycles(roots: &[usize], parents: &[Vec<usize>]) -> Vec<usize> {
    let mut index = vec![usize::MAX; parents.len()];
    let mut low = vec![0; parents.len()];
    let mut active = vec![false; parents.len()];
    let mut stack = Vec::new();
    let mut frames = Vec::new();
    let mut result = Vec::new();
    let mut next_index = 0;
    for &root in roots {
        if index[root] != usize::MAX {
            continue;
        }
        frames.push((root, 0));
        while let Some((row, edge)) = frames.last_mut() {
            let row = *row;
            if index[row] == usize::MAX {
                index[row] = next_index;
                low[row] = next_index;
                next_index += 1;
                active[row] = true;
                stack.push(row);
            }
            if let Some(&parent) = parents[row].get(*edge) {
                *edge += 1;
                if index[parent] == usize::MAX {
                    frames.push((parent, 0));
                } else if active[parent] {
                    low[row] = low[row].min(index[parent]);
                }
                continue;
            }
            if low[row] == index[row] {
                // DFS entered each row exactly once. Its SCC occupies the active suffix.
                let start =
                    stack.len() - 1 - stack.iter().rev().position(|&node| node == row).unwrap();
                if start + 1 < stack.len() {
                    result.extend(stack[start..].iter().rev().copied());
                }
                for node in stack.drain(start..) {
                    active[node] = false;
                }
            }
            frames.pop();
            if let Some(&(caller, _)) = frames.last() {
                low[caller] = low[caller].min(low[row]);
            }
        }
    }
    result
}

pub fn find_overlaps(numbers: &[i64], files: &[Vec<u32>]) -> Vec<Vec<Overlap>> {
    let mut by_file = HashMap::<u32, Vec<(usize, usize)>>::new();
    for (row, paths) in files.iter().enumerate() {
        for &file in paths {
            let occurrences = by_file.entry(file).or_default();
            match occurrences.last_mut() {
                Some((previous, count)) if *previous == row => *count += 1,
                _ => occurrences.push((row, 1)),
            }
        }
    }
    files
        .iter()
        .enumerate()
        .map(|(row, paths)| {
            let mut shared = BTreeMap::<i64, Vec<u32>>::new();
            for file in paths.iter().copied().collect::<HashSet<_>>() {
                for &(other, count) in &by_file[&file] {
                    if other != row {
                        shared
                            .entry(numbers[other])
                            .or_default()
                            .extend(std::iter::repeat_n(file, count));
                    }
                }
            }
            shared
                .into_iter()
                .map(|(number, files)| Overlap { number, files })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_stack_uses_iterative_traversal() {
        let count = 20_000;
        let heads: Vec<u32> = (1..=count).collect();
        let bases = (2..=count).chain([count + 1]).collect::<Vec<_>>();
        let numbers = heads.iter().map(|&id| i64::from(id)).collect::<Vec<_>>();
        let result = analyze_dependencies(&numbers, &heads, &bases, count + 1);
        assert!(result.cyclic.is_empty());
        assert_eq!(result.order, numbers.into_iter().rev().collect::<Vec<_>>());
    }

    #[test]
    fn overlaps_count_occurrences_on_the_other_side_only() {
        let result = find_overlaps(&[42, 3, 9], &[vec![1, 1], vec![1, 1, 1], vec![2]]);
        assert_eq!(result[0][0].number, 3);
        assert_eq!(result[0][0].files, vec![1, 1, 1]);
        assert_eq!(result[1][0].files, vec![1, 1]);
        assert!(result[2].is_empty());
    }
}
