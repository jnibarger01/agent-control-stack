//! ACS core: canonical hashing (v2), legacy v1 verification of existing records, and read-only
//! access to the SQLite store. TypeScript remains the only writer and the only authority.
//!
//! The TypeScript implementation in `packages/shared` is the reference. Parity is checked by
//! `scripts/audit-chain-parity.ts` and by `contracts/canonical-hash/v2.golden.json`.
#![forbid(unsafe_code)]

pub mod audit;
pub mod canonical;
pub mod legacy;
pub mod store;
pub mod work_items;
