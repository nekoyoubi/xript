use ratatui::layout::{Constraint, Direction};

pub fn parse_constraint(s: &str) -> Option<Constraint> {
    let (kind, value) = s.split_once(':')?;

    match kind {
        "Length" => {
            let n: u16 = value.parse().ok()?;
            Some(Constraint::Length(n))
        }
        "Min" => {
            let n: u16 = value.parse().ok()?;
            Some(Constraint::Min(n))
        }
        "Max" => {
            let n: u16 = value.parse().ok()?;
            Some(Constraint::Max(n))
        }
        "Percentage" => {
            let n: u16 = value.parse().ok()?;
            Some(Constraint::Percentage(n))
        }
        "Ratio" => {
            let (num, den) = value.split_once(',')?;
            let num: u32 = num.trim().parse().ok()?;
            let den: u32 = den.trim().parse().ok()?;
            Some(Constraint::Ratio(num, den))
        }
        "Fill" => {
            let n: u16 = value.parse().ok()?;
            Some(Constraint::Fill(n))
        }
        _ => None,
    }
}

pub fn parse_direction(s: &str) -> Direction {
    match s {
        "Horizontal" => Direction::Horizontal,
        _ => Direction::Vertical,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_length_constraint() {
        assert_eq!(parse_constraint("Length:3"), Some(Constraint::Length(3)));
    }

    #[test]
    fn parses_min_constraint() {
        assert_eq!(parse_constraint("Min:1"), Some(Constraint::Min(1)));
    }

    #[test]
    fn parses_max_constraint() {
        assert_eq!(parse_constraint("Max:10"), Some(Constraint::Max(10)));
    }

    #[test]
    fn parses_percentage_constraint() {
        assert_eq!(
            parse_constraint("Percentage:50"),
            Some(Constraint::Percentage(50))
        );
    }

    #[test]
    fn parses_ratio_constraint() {
        assert_eq!(
            parse_constraint("Ratio:1,3"),
            Some(Constraint::Ratio(1, 3))
        );
    }

    #[test]
    fn parses_ratio_with_spaces() {
        assert_eq!(
            parse_constraint("Ratio:1, 3"),
            Some(Constraint::Ratio(1, 3))
        );
    }

    #[test]
    fn parses_fill_constraint() {
        assert_eq!(parse_constraint("Fill:1"), Some(Constraint::Fill(1)));
    }

    #[test]
    fn returns_none_for_unknown_kind() {
        assert_eq!(parse_constraint("Flex:1"), None);
    }

    #[test]
    fn returns_none_for_missing_colon() {
        assert_eq!(parse_constraint("Length3"), None);
    }

    #[test]
    fn returns_none_for_invalid_number() {
        assert_eq!(parse_constraint("Length:abc"), None);
    }

    #[test]
    fn parses_vertical_direction() {
        assert_eq!(parse_direction("Vertical"), Direction::Vertical);
    }

    #[test]
    fn parses_horizontal_direction() {
        assert_eq!(parse_direction("Horizontal"), Direction::Horizontal);
    }

    #[test]
    fn defaults_to_vertical_for_unknown() {
        assert_eq!(parse_direction("Diagonal"), Direction::Vertical);
    }
}
