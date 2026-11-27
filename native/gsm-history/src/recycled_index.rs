//! Exact FIFO membership. Each hash table entry points to a ring slot owning the only stored key.
use hashbrown::HashTable;
use smallvec::SmallVec;
use std::{collections::hash_map::RandomState, hash::BuildHasher};

pub type Key = SmallVec<[u8; 160]>;

#[derive(Default)]
pub struct Index {
    limit: usize,
    keys: Vec<Box<[u8]>>,
    slots: HashTable<usize>,
    oldest: usize,
    hasher: RandomState,
}

impl Index {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            ..Default::default()
        }
    }
    pub fn len(&self) -> usize {
        self.keys.len()
    }
    pub fn contains(&self, key: &[u8]) -> bool {
        self.slots
            .find(self.hasher.hash_one(key), |&i| self.keys[i].as_ref() == key)
            .is_some()
    }
    pub fn add(&mut self, key: Key) {
        if self.limit == 0 {
            return;
        }
        let hash = self.hasher.hash_one(&key[..]);
        if self
            .slots
            .find(hash, |&i| *self.keys[i] == key[..])
            .is_some()
        {
            return;
        }
        let slot = if self.keys.len() == self.limit {
            let i = self.oldest;
            let old_hash = self.hasher.hash_one(&*self.keys[i]);
            self.slots
                .find_entry(old_hash, |&slot| slot == i)
                .expect("occupied ring slot")
                .remove();
            self.keys[i] = key.into_boxed_slice();
            self.oldest = (i + 1) % self.limit;
            i
        } else {
            let i = self.keys.len();
            self.keys.push(key.into_boxed_slice());
            i
        };
        self.slots
            .insert_unique(hash, slot, |&i| self.hasher.hash_one(&*self.keys[i]));
    }
}

impl IntoIterator for Index {
    type Item = Box<[u8]>;
    type IntoIter = std::vec::IntoIter<Self::Item>;
    fn into_iter(self) -> Self::IntoIter {
        let mut keys = self.keys;
        keys.rotate_left(self.oldest);
        keys.into_iter()
    }
}
