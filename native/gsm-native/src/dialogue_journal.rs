use hashlink::linked_hash_map::Entry;
use hashlink::LinkedHashMap;
use smallvec::SmallVec;
use std::hash::Hash;

const PREFIX_SOURCES: usize = 512;
const PENDING_LIMIT: usize = 512;
// Generated observation and line IDs occupy exactly 36 ASCII bytes. Longer
// caller-supplied IDs spill to the heap without changing their identity.
type Id = SmallVec<[u8; 36]>;

#[derive(Clone, Copy)]
struct Pending {
    changed_ns: i128,
    manual: bool,
    frozen: bool,
}

#[derive(Default)]
pub struct Stats<'a> {
    pub status: &'a str,
    pub frozen: bool,
    pub observed_ns: Option<i128>,
}

// One ordered index per collection. Updating a record keeps its original position.
// Only a successful source write renews a prefix, and retries never renew receipts.
pub struct Journal<R, K, P> {
    records: LinkedHashMap<Id, R>,
    receipts: LinkedHashMap<Id, ()>,
    prefixes: LinkedHashMap<K, P>,
    pending: LinkedHashMap<Id, Pending>,
    sequence: u64,
}

impl<R, K: Hash + Eq, P> Journal<R, K, P> {
    pub fn new() -> Self {
        Self {
            records: LinkedHashMap::new(),
            receipts: LinkedHashMap::new(),
            prefixes: LinkedHashMap::new(),
            pending: LinkedHashMap::new(),
            sequence: 0,
        }
    }

    pub fn observe(&mut self, id: &[u8], limit: usize) -> bool {
        if self.receipts.contains_key(id) {
            return false;
        }
        if limit > 0 {
            self.receipts.insert(id.into(), ());
        }
        while self.receipts.len() > limit {
            self.receipts.pop_front();
        }
        true
    }

    pub fn get(&self, id: &[u8]) -> Option<&R> {
        self.records.get(id)
    }

    pub fn latest(&self) -> Option<&R> {
        self.records.back().map(|(_, row)| row)
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn rows(&self) -> impl ExactSizeIterator<Item = &R> + DoubleEndedIterator {
        self.records.values()
    }

    pub fn prefix(&self, key: &K) -> Option<&P> {
        self.prefixes.get(key)
    }

    pub fn prefixes(&self) -> impl Iterator<Item = &P> {
        self.prefixes.values()
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    fn update_pending(
        &mut self,
        id: &[u8],
        Stats {
            status,
            frozen,
            observed_ns,
        }: Stats<'_>,
    ) {
        let manual = status == "pending_manual";
        if !manual && status != "pending" {
            if self.has_pending() {
                self.pending.remove(id);
            }
        } else if let Some(row) = self.pending.get_mut(id) {
            row.frozen = frozen;
            row.manual = manual;
            if let Some(tick) = observed_ns {
                row.changed_ns = tick;
            }
        } else if let Some(changed_ns) = observed_ns {
            self.pending.insert(
                id.into(),
                Pending {
                    changed_ns,
                    manual,
                    frozen,
                },
            );
        }
    }

    pub fn pending(&self) -> impl Iterator<Item = &R> {
        self.pending.keys().map(|id| &self.records[id])
    }

    pub fn ready(&self, cutoff_ns: i128) -> impl Iterator<Item = &R> {
        self.pending
            .iter()
            .take_while(move |(_, p)| p.frozen && (p.manual || p.changed_ns < cutoff_ns))
            .map(|(id, _)| &self.records[id])
    }

    pub fn for_exclusion(&self, confirmed: bool) -> impl Iterator<Item = &R> {
        let limit = if confirmed {
            usize::MAX
        } else {
            usize::from(self.pending.len() > PENDING_LIMIT)
        };
        self.pending
            .iter()
            .filter(|(_, p)| !p.manual)
            .take(limit)
            .map(|(id, _)| &self.records[id])
    }

    pub fn publish(
        &mut self,
        id: &[u8],
        record: R,
        append: bool,
        source: Option<(K, P)>,
        stats: Stats<'_>,
    ) -> Result<(), &'static str> {
        if append {
            match self.records.entry(id.into()) {
                Entry::Vacant(slot) => {
                    slot.insert(record);
                    self.sequence += 1;
                }
                Entry::Occupied(_) => return Err("line ID is already present"),
            }
        } else {
            *self.records.get_mut(id).ok_or("line ID is absent")? = record;
        }
        if let Some((key, previous)) = source {
            self.prefixes.insert(key, previous);
            if self.prefixes.len() > PREFIX_SOURCES {
                self.prefixes.pop_front();
            }
        }
        self.update_pending(id, stats);
        Ok(())
    }

    // Compare the contiguous prefix before unlinking it. A failed comparison
    // leaves the journal and sequence intact.
    pub fn expire<E>(
        &mut self,
        mut eligible: impl FnMut(&R) -> Result<bool, E>,
    ) -> Result<Vec<R>, E> {
        let mut count = 0;
        for (id, row) in &self.records {
            if (self.has_pending() && self.pending.contains_key(id)) || !eligible(row)? {
                break;
            }
            count += 1;
        }
        Ok((0..count)
            .map(|_| self.records.pop_front().expect("counted retained row").1)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_revision_or_comparison_does_not_change_order_or_source() {
        let mut journal = Journal::new();
        journal
            .publish(b"a", 1, true, Some((1, "first")), Stats::default())
            .unwrap();
        journal
            .publish(b"b", 2, true, None, Stats::default())
            .unwrap();
        assert!(journal
            .publish(b"a", 77, true, Some((1, "bad")), Stats::default())
            .is_err());
        assert!(journal
            .publish(b"c", 33, false, Some((1, "bad")), Stats::default())
            .is_err());
        journal
            .publish(b"a", 3, false, None, Stats::default())
            .unwrap();
        assert!(journal
            .expire(|r| if *r == 2 { Err(()) } else { Ok(true) })
            .is_err());
        assert_eq!(journal.sequence(), 2);
        assert_eq!(journal.prefix(&1), Some(&"first"));
        assert_eq!(journal.latest(), Some(&2));
        assert_eq!(journal.rows().copied().collect::<Vec<_>>(), [3, 2]);
    }
}
