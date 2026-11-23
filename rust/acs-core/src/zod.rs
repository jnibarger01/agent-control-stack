//! Exact ports of the Zod 4.6.7 string validators the stored-record schemas use. Each mirrors the pattern Zod
//! compiles (extracted from the running library, not re-derived), so a row TypeScript rejects is rejected here.

/// `identifierSchema`: `z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)`.
pub fn is_identifier(text: &str) -> bool {
    let mut bytes = text.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    text.chars().count() <= 128
        && first.is_ascii_alphanumeric()
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// `hashSchema`: `/^[a-f0-9]{64}$/u`.
pub fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `timestampSchema`: `z.string().datetime({ offset: true }).max(64)`. Zod's compiled pattern:
///
/// ```text
/// ^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29
///   |\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))
///  T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$
/// ```
pub fn is_timestamp(text: &str) -> bool {
    if text.chars().count() > 64 {
        return false;
    }
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let slice = bytes.get(range)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(
            slice
                .iter()
                .fold(0, |value, b| value * 10 + u32::from(b - b'0')),
        )
    };
    let at = |index: usize, expected: u8| bytes.get(index) == Some(&expected);
    let (Some(year), Some(month), Some(day)) = (digits(0..4), digits(5..7), digits(8..10)) else {
        return false;
    };
    if !(at(4, b'-') && at(7, b'-') && at(10, b'T')) {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    if day < 1 || day > max_day {
        return false;
    }
    let (Some(hour), Some(minute), Some(second)) = (digits(11..13), digits(14..16), digits(17..19))
    else {
        return false;
    };
    if !(at(13, b':') && at(16, b':')) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let mut index = 19;
    if at(index, b'.') {
        let start = index + 1;
        index = start;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return false;
        }
    }
    match bytes.get(index) {
        Some(b'Z') => index + 1 == bytes.len(),
        Some(b'+' | b'-') => {
            let (Some(offset_hour), Some(offset_minute)) =
                (digits(index + 1..index + 3), digits(index + 4..index + 6))
            else {
                return false;
            };
            at(index + 3, b':')
                && offset_hour <= 23
                && offset_minute <= 59
                && index + 6 == bytes.len()
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{is_hash, is_identifier, is_timestamp};

    /// Every answer below was produced by Zod 4.6.7 itself (`z.string().datetime({ offset: true })`).
    #[test]
    fn timestamps_match_the_answers_zod_gave() {
        for (value, zod) in [
            ("2026-11-23T08:30:26Z", true),
            ("2026-11-23T08:30:26.123456789Z", true),
            ("2026-11-23T08:30:26+05:30", true),
            ("2026-11-23T08:30:26+0530", false),
            ("2026-11-23T08:30:26+05", false),
            ("2026-02-29T00:00:00Z", false),
            ("2024-02-29T00:00:00Z", true),
            ("2026-11-23T08:30Z", false),
            ("2026-11-23T24:00:00Z", false),
            ("2026-11-23 08:30:26Z", false),
            ("2026-11-23T08:30:26", false),
        ] {
            assert_eq!(is_timestamp(value), zod, "{value}");
        }
    }

    #[test]
    fn identifiers_and_hashes() {
        assert!(is_identifier("attempt_10767f2b-fe65:a.b"));
        assert!(!is_identifier("_leading"));
        assert!(!is_identifier(""));
        assert!(!is_identifier(&"a".repeat(129)));
        assert!(is_hash(&"0a".repeat(32)));
        assert!(!is_hash(&"0A".repeat(32)));
    }
}
