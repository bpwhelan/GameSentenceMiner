pub type SpatialLineInput = (String, f64, f64, f64, f64, bool);

pub fn build_spatial_text(
    lines: &[SpatialLineInput],
    same_axis_height_ratio: f64,
    blank_line_height_ratio: f64,
    blank_line_token: Option<&str>,
) -> String {
    let mut result = String::new();
    let mut previous: Option<&SpatialLineInput> = None;

    for entry in lines {
        if entry.0.is_empty() {
            continue;
        }

        if let Some(previous) = previous {
            let use_vertical_axis = previous.5 && entry.5;
            let (previous_center, current_center, previous_dimension, current_dimension) =
                if use_vertical_axis {
                    (previous.1, entry.1, previous.3.max(1.0), entry.3.max(1.0))
                } else {
                    (previous.2, entry.2, previous.4.max(1.0), entry.4.max(1.0))
                };

            let axis_distance = (current_center - previous_center).abs();
            let same_axis_threshold =
                previous_dimension.max(current_dimension) * same_axis_height_ratio;
            if axis_distance <= same_axis_threshold {
                if should_insert_inter_line_space(&previous.0, &entry.0) {
                    result.push(' ');
                }
            } else {
                let average_dimension = (previous_dimension + current_dimension) / 2.0;
                if let Some(token) = blank_line_token
                    .filter(|_| axis_distance > average_dimension * blank_line_height_ratio)
                {
                    result.push('\n');
                    result.push_str(token);
                    result.push('\n');
                } else {
                    result.push('\n');
                }
            }
        }

        result.push_str(&entry.0);
        previous = Some(entry);
    }
    result
}

fn should_insert_inter_line_space(previous: &str, current: &str) -> bool {
    let Some(previous_last) = previous.chars().next_back() else {
        return false;
    };
    let Some(current_first) = current.chars().next() else {
        return false;
    };
    if previous_last.is_whitespace() || current_first.is_whitespace() {
        return false;
    }
    if "([{\"'「『（【〈《［｛＜".contains(previous_last) {
        return false;
    }
    !")]},.!?:;%…，。、？！：；」』）】〉》］｝＞".contains(current_first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adjacent_lines_follow_the_existing_axis_spacing_contract() {
        let lines = vec![
            ("続き".to_owned(), 100.0, 20.0, 50.0, 20.0, false),
            ("です。".to_owned(), 160.0, 21.0, 45.0, 20.0, false),
        ];
        assert_eq!(build_spatial_text(&lines, 0.6, 2.0, None), "続き です。");
    }
}
