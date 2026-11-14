//! Batch detected text into a small number of Lens images, retaining the exact
//! crop-to-source mapping for both lines and word lookup targets.
use crate::pipeline::{TextBox, remap_line};
use image::{Rgba, RgbaImage};

pub struct Composite {
    pub image: RgbaImage,
    regions: Vec<([u32; 4], [u32; 2])>,
}
pub fn pack(image: &RgbaImage, boxes: &[[f64; 4]]) -> Vec<Composite> {
    let mut crops = Vec::<[u32; 4]>::new();
    for b in boxes.iter().take(4096) {
        if b.iter().any(|x| !x.is_finite()) {
            continue;
        }
        let x = b[0].floor().max(0.) as u32;
        let y = b[1].floor().max(0.) as u32;
        let right = (b[2].ceil().max(0.) as u32).min(image.width());
        let bottom = (b[3].ceil().max(0.) as u32).min(image.height());
        if right <= x || bottom <= y {
            continue;
        }
        if crops
            .iter()
            .any(|p| x >= p[0] && y >= p[1] && right <= p[0] + p[2] && bottom <= p[1] + p[3])
        {
            continue;
        }
        crops.push([x, y, right - x, bottom - y]);
    }
    let mut result = Vec::new();
    let mut group = Vec::new();
    let (mut width, mut height) = (0u32, 0u32);
    for crop in crops {
        let next_width = width.max(crop[2] + 16);
        let next_height = height + crop[3] + 16;
        if !group.is_empty()
            && (next_width as u64 * next_height as u64 > 3_000_000 || next_height > 3000)
        {
            result.push(make(image, &group, width, height));
            group.clear();
            width = 0;
            height = 0;
        }
        width = width.max(crop[2] + 16);
        group.push((crop, [8, height + 8]));
        height += crop[3] + 16;
    }
    if !group.is_empty() {
        result.push(make(image, &group, width, height));
    }
    result
}
fn make(
    source: &RgbaImage,
    regions: &[([u32; 4], [u32; 2])],
    width: u32,
    height: u32,
) -> Composite {
    let mut image = RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]));
    for (b, offset) in regions {
        let crop = image::imageops::crop_imm(source, b[0], b[1], b[2], b[3]).to_image();
        image::imageops::replace(&mut image, &crop, offset[0] as i64, offset[1] as i64);
    }
    Composite {
        image,
        regions: regions.to_vec(),
    }
}
impl Composite {
    pub fn restore(&self, lines: Vec<TextBox>) -> Vec<TextBox> {
        lines
            .into_iter()
            .filter_map(|mut line| {
                let x = (line.bounds[0] + line.bounds[2]) / 2.;
                let y = (line.bounds[1] + line.bounds[3]) / 2.;
                let (source, offset) = self.regions.iter().find(|(b, p)| {
                    x >= p[0] as f64
                        && y >= p[1] as f64
                        && x <= (p[0] + b[2]) as f64
                        && y <= (p[1] + b[3]) as f64
                })?;
                remap_line(
                    &mut line,
                    (
                        source[0] as f64 - offset[0] as f64,
                        source[1] as f64 - offset[1] as f64,
                    ),
                    (1., 1.),
                );
                Some(line)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn batches_crops_and_restores_word_coordinates() {
        let source = RgbaImage::from_pixel(800, 600, Rgba([1, 2, 3, 255]));
        let batch = pack(
            &source,
            &[[100., 200., 300., 230.], [400., 300., 700., 330.]],
        );
        assert_eq!(batch.len(), 1);
        let line = TextBox {
            text: "猫".into(),
            bounds: [8., 54., 38., 84.],
            words: vec![TextBox {
                text: "猫".into(),
                bounds: [8., 54., 38., 84.],
                ..Default::default()
            }],
            ..Default::default()
        };
        let restored = batch[0].restore(vec![line]);
        assert_eq!(restored[0].bounds, [400., 300., 430., 330.]);
        assert_eq!(restored[0].words[0].bounds, restored[0].bounds);
    }
    #[test]
    fn invalid_regions_are_ignored_and_large_batches_are_bounded() {
        let source = RgbaImage::new(2000, 2000);
        assert!(pack(&source, &[[f64::NAN, 0., 2., 2.], [4., 4., 3., 3.]]).is_empty());
        let batch = pack(
            &source,
            &[[0., 0., 1800., 1000.], [0., 1000., 1800., 2000.]],
        );
        assert_eq!(batch.len(), 2);
        assert!(
            batch
                .iter()
                .all(|b| b.image.width() as u64 * b.image.height() as u64 <= 3_000_000)
        );
    }
}
