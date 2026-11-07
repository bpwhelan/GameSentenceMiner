import numpy as np
import pytest

from scripts.benchmark_vocr_native import map_digest


def test_detector_hash_compares_values_independently_of_backend_storage_dtype():
    maps = np.array([-128, -1, 0, 127], dtype=np.int8).reshape(2, 2)
    assert map_digest(maps) == map_digest(maps.astype(np.int64))
    changed = maps.copy()
    changed[0, 1] = -2
    assert map_digest(changed) != map_digest(maps)


@pytest.mark.parametrize("values", [[128], [-129], [0.5]])
def test_detector_hash_refuses_lossy_conversion(values):
    with pytest.raises(ValueError):
        map_digest(np.array(values))
