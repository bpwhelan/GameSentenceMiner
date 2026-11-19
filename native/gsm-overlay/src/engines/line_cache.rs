use crate::pipeline::TextBox;
use image::RgbaImage;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Each model owns its cache. Include geometry because cached word boxes are
/// in source coordinates. Hash every source pixel that can influence a line.
pub(super) fn key(image: &RgbaImage, rect: [u32; 4], polarity: Option<bool>) -> [u8; 32] {
    let [x, y, w, h] = rect;
    let mut digest = Sha256::new();
    for value in rect {
        digest.update(value.to_le_bytes());
    }
    digest.update([polarity.map_or(2, u8::from)]);
    let stride = image.width() as usize * 4;
    for row in y..y + h {
        let start = row as usize * stride + x as usize * 4;
        digest.update(&image.as_raw()[start..start + w as usize * 4]);
    }
    digest.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pixel_changes_polarity_coordinates_and_expiry_invalidate_hits() {
        let mut image = RgbaImage::new(5, 2);
        let rect = [1, 0, 3, 2];
        let original = key(&image, rect, Some(false));
        let mut cache = LineCache::default();
        cache.begin();
        cache.insert(
            original,
            &TextBox {
                text: "台詞".into(),
                ..Default::default()
            },
        );
        image.get_pixel_mut(0, 0)[0] = 1;
        assert_eq!(
            cache.get(&key(&image, rect, Some(false))).unwrap().text,
            "台詞"
        );
        assert_ne!(key(&image, [2, 0, 3, 2], Some(false)), original);
        assert_ne!(key(&image, rect, Some(true)), original);
        image.get_pixel_mut(2, 1)[0] = 1;
        assert_ne!(key(&image, rect, Some(false)), original);
        for _ in 0..5 {
            cache.begin();
        }
        assert!(cache.get(&original).is_none());
    }
}

#[derive(Default)]
pub(super) struct LineCache {
    reading: u64,
    entries: HashMap<[u8; 32], (u64, TextBox)>,
}
impl LineCache {
    pub fn begin(&mut self) {
        self.reading += 1;
        self.entries
            .retain(|_, (seen, _)| self.reading - *seen <= 4);
    }
    pub fn get(&mut self, key: &[u8; 32]) -> Option<TextBox> {
        let (seen, line) = self.entries.get_mut(key)?;
        *seen = self.reading;
        Some(line.clone())
    }
    pub fn insert(&mut self, key: [u8; 32], line: &TextBox) {
        if self.entries.len() < 512 {
            self.entries.insert(key, (self.reading, line.clone()));
        }
    }
}
