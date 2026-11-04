//! ISO 8601 timestamps without a date crate, matching JavaScript's toISOString().

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub fn now_iso() -> String {
    iso_from_millis(now_millis())
}

pub fn iso_from_system_time(time: SystemTime) -> String {
    iso_from_millis(time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64))
}

pub fn iso_from_millis(millis: i64) -> String {
    let secs = millis.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        millis.rem_euclid(1000)
    )
}

/// Days since 1970-01-01 to a (year, month, day) date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_790_848_844_503), "2026-10-01T10:00:44.503Z");
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
    }
}

/// Milliseconds since the epoch of an ISO 8601 UTC time like "2026-10-01T09:49:25.307Z".
pub fn millis_from_iso(iso: &str) -> Option<i64> {
    let (date, time) = iso.strip_suffix('Z')?.split_once('T')?;
    let mut date_parts = date.splitn(3, '-').map(str::parse::<i64>);
    let (y, m, d) = (date_parts.next()?.ok()?, date_parts.next()?.ok()?, date_parts.next()?.ok()?);
    let (hms, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.splitn(3, ':').map(str::parse::<i64>);
    let (h, min, s) = (time_parts.next()?.ok()?, time_parts.next()?.ok()?, time_parts.next()?.ok()?);
    let millis: i64 = format!("{fraction:0<3}").get(..3)?.parse().ok()?;
    Some((days_from_civil(y, m, d) * 86_400 + h * 3600 + min * 60 + s) * 1000 + millis)
}

/// Milliseconds since the epoch of a UTC time as SQLite and Go write it: "2026-10-01 10:00:00",
/// with or without fractions, a "T", a "Z" or a "+00:00".
pub fn millis_from_sql_time(time: &str) -> Option<i64> {
    let time = time.trim().replacen(' ', "T", 1);
    let time = time.strip_suffix("+00:00").map(str::to_owned).unwrap_or(time);
    let time = if time.ends_with('Z') { time } else { format!("{time}Z") };
    millis_from_iso(&time)
}

/// Days since 1970-01-01 of a date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn parses_iso_times() {
        assert_eq!(millis_from_iso("2026-10-01T10:00:44.503Z"), Some(1_790_848_844_503));
        assert_eq!(millis_from_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(millis_from_iso("2024-02-29T12:00:00.5Z").map(iso_from_millis).as_deref(), Some("2024-02-29T12:00:00.500Z"));
        assert_eq!(millis_from_iso("yesterday"), None);
        assert_eq!(millis_from_sql_time("2026-10-01 10:00:44.503"), Some(1_790_848_844_503));
        assert_eq!(millis_from_sql_time("2026-10-01T10:00:44.503+00:00"), Some(1_790_848_844_503));
    }
}
