//! Node-API bindings for the integration graph pilot.
#![deny(unsafe_code)]

mod port;
#[cfg(test)]
mod port_cases;

use napi::{Error, Result, Status};
use napi_derive::napi;

#[napi(object)]
pub struct DependencyAnalysis {
    pub parents: Vec<Vec<i64>>,
    pub cyclic: Vec<i64>,
    pub blocked_by_cycle: Vec<i64>,
    pub detached: Vec<i64>,
    pub order: Vec<i64>,
}

#[napi(object)]
pub struct Overlap {
    pub number: i64,
    pub files: Vec<u32>,
}

#[napi]
pub fn graph_abi_version() -> u32 {
    1
}

#[napi]
pub fn analyze_dependencies(
    numbers: Vec<i64>,
    heads: Vec<u32>,
    bases: Vec<u32>,
    target: u32,
) -> Result<DependencyAnalysis> {
    if heads.len() != numbers.len() || bases.len() != numbers.len() {
        return Err(Error::new(
            Status::InvalidArg,
            "dependency column length mismatch",
        ));
    }
    Ok(port::analyze_dependencies(&numbers, &heads, &bases, target))
}

#[napi]
pub fn find_overlaps(numbers: Vec<i64>, files: Vec<Vec<u32>>) -> Result<Vec<Vec<Overlap>>> {
    if files.len() != numbers.len() {
        return Err(Error::new(
            Status::InvalidArg,
            "overlap column length mismatch",
        ));
    }
    Ok(port::find_overlaps(&numbers, &files))
}
