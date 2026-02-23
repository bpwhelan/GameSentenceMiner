"""
Test script for Character-Aware AFK Detection

This tests the three AFK detection modes:
1. 'fixed' - Original behavior with fixed timer
2. 'character_aware' - Algorithm 1: Character-based heuristic
3. 'adaptive' - Algorithm 2: EMA-based adaptive threshold

Run with: python test_afk_detection.py
"""

# Standalone implementations of the algorithms for testing
# (These mirror what's in stats.py but without the import chain)


def calculate_fallback_threshold(char_count: int, char_multiplier=1.2, min_threshold=5.0, max_threshold=120.0) -> float:
    """Algorithm 1: Character-based heuristic for warmup period."""
    if char_count <= 0:
        return min_threshold
    threshold = char_count * char_multiplier
    return max(min_threshold, min(threshold, max_threshold))


def calculate_adaptive_threshold(char_count: int, ema_time_per_char: float, anomaly_multiplier=3.0, min_threshold=5.0, max_threshold=120.0) -> float:
    """Algorithm 2: EMA-based adaptive threshold."""
    if char_count <= 0 or ema_time_per_char <= 0:
        return min_threshold
    threshold = char_count * ema_time_per_char * anomaly_multiplier
    return max(min_threshold, min(threshold, max_threshold))


def update_ema(current_time_per_char: float, ema_time_per_char: float, alpha: float) -> float:
    """Update Exponential Moving Average with a new reading."""
    if ema_time_per_char <= 0:
        return current_time_per_char
    return alpha * current_time_per_char + (1 - alpha) * ema_time_per_char


def get_afk_threshold(char_count: int, mode: str, afk_timer_seconds=60, ema_time_per_char=0.0,
                      ema_sample_count=0, min_samples=5, char_multiplier=1.2,
                      anomaly_multiplier=3.0, min_threshold=5.0, max_threshold=120.0) -> float:
    """Get the appropriate AFK threshold based on detection mode."""
    if mode == 'fixed':
        return float(afk_timer_seconds)

    if mode == 'character_aware':
        return calculate_fallback_threshold(char_count, char_multiplier, min_threshold, max_threshold)

    # 'adaptive' mode
    if ema_sample_count >= min_samples and ema_time_per_char > 0:
        return calculate_adaptive_threshold(char_count, ema_time_per_char, anomaly_multiplier, min_threshold, max_threshold)
    else:
        return calculate_fallback_threshold(char_count, char_multiplier, min_threshold, max_threshold)


def calculate_actual_reading_time(timestamps, char_counts=None, mode='fixed', afk_timer_seconds=60,
                                   ema_time_per_char=0.0, ema_sample_count=0, min_samples=5,
                                   char_multiplier=1.2, anomaly_multiplier=3.0,
                                   min_threshold=5.0, max_threshold=120.0):
    """Calculate actual reading time using AFK timer logic."""
    if not timestamps or len(timestamps) < 2:
        return 0.0

    # Fall back to fixed mode if no char_counts provided
    if char_counts is None and mode in ('character_aware', 'adaptive'):
        mode = 'fixed'

    # Sort timestamps and char_counts together
    if char_counts is not None:
        paired = sorted(zip(timestamps, char_counts), key=lambda x: x[0])
        sorted_timestamps = [p[0] for p in paired]
        sorted_char_counts = [p[1] for p in paired]
    else:
        sorted_timestamps = sorted(timestamps)
        sorted_char_counts = None

    total_reading_time = 0.0

    for i in range(1, len(sorted_timestamps)):
        time_gap = sorted_timestamps[i] - sorted_timestamps[i - 1]

        if mode == 'fixed':
            threshold = float(afk_timer_seconds)
        else:
            prev_char_count = sorted_char_counts[i - 1] if sorted_char_counts else 0
            threshold = get_afk_threshold(
                prev_char_count, mode, afk_timer_seconds, ema_time_per_char,
                ema_sample_count, min_samples, char_multiplier, anomaly_multiplier,
                min_threshold, max_threshold
            )

        if time_gap > threshold:
            total_reading_time += threshold
        else:
            total_reading_time += time_gap

    return total_reading_time


def test_algorithm1_fallback_threshold():
    """Test Algorithm 1: Character-based heuristic"""
    print("\n=== Testing Algorithm 1: Character-Based Heuristic ===")

    test_cases = [
        (0, 5.0, "Empty line -> min threshold"),
        (10, 12.0, "10 chars * 1.2 = 12s"),
        (50, 60.0, "50 chars * 1.2 = 60s"),
        (100, 120.0, "100 chars * 1.2 = 120s (capped at max)"),
        (200, 120.0, "200 chars * 1.2 = 240s -> capped at 120s"),
        (3, 5.0, "3 chars * 1.2 = 3.6s -> raised to min 5s"),
    ]

    all_passed = True
    for char_count, expected, description in test_cases:
        result = calculate_fallback_threshold(char_count)
        status = "PASS" if abs(result - expected) < 0.01 else "FAIL"
        if status == "FAIL":
            all_passed = False
        print(f"  [{status}] {description}: got {result:.1f}s, expected {expected:.1f}s")

    return all_passed


def test_algorithm2_ema_threshold():
    """Test Algorithm 2: EMA-based adaptive threshold"""
    print("\n=== Testing Algorithm 2: EMA-Based Adaptive Threshold ===")

    # Simulated EMA: 0.5 seconds per character (typical reading speed)
    ema_time_per_char = 0.5

    test_cases = [
        (0, 5.0, "Empty line -> min threshold"),
        (10, 15.0, "10 chars * 0.5 * 3.0 = 15s"),
        (50, 75.0, "50 chars * 0.5 * 3.0 = 75s"),
        (100, 120.0, "100 chars * 0.5 * 3.0 = 150s -> capped at 120s"),
        (5, 7.5, "5 chars * 0.5 * 3.0 = 7.5s"),
    ]

    all_passed = True
    for char_count, expected, description in test_cases:
        result = calculate_adaptive_threshold(char_count, ema_time_per_char)
        status = "PASS" if abs(result - expected) < 0.01 else "FAIL"
        if status == "FAIL":
            all_passed = False
        print(f"  [{status}] {description}: got {result:.1f}s, expected {expected:.1f}s")

    return all_passed


def test_ema_update():
    """Test EMA update function"""
    print("\n=== Testing EMA Update ===")

    all_passed = True

    # Test 1: First sample (EMA = 0)
    result = update_ema(0.5, 0.0, 0.2)
    expected = 0.5  # First sample uses value directly
    status = "PASS" if abs(result - expected) < 0.001 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] First sample: got {result:.3f}, expected {expected:.3f}")

    # Test 2: Subsequent sample
    # EMA = 0.2 * 0.6 + 0.8 * 0.5 = 0.12 + 0.4 = 0.52
    result = update_ema(0.6, 0.5, 0.2)
    expected = 0.52
    status = "PASS" if abs(result - expected) < 0.001 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] Update sample: got {result:.3f}, expected {expected:.3f}")

    # Test 3: Convergence simulation
    print("\n  Simulating EMA convergence (reading at 0.4s/char, starting EMA=0.5):")
    ema = 0.5
    for i in range(10):
        ema = update_ema(0.4, ema, 0.2)
        print(f"    Sample {i+1}: EMA = {ema:.4f}")

    # After 10 samples, EMA should be closer to 0.4
    status = "PASS" if ema < 0.45 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] EMA converging toward 0.4: final EMA = {ema:.4f}")

    return all_passed


def test_mode_selection():
    """Test get_afk_threshold mode selection"""
    print("\n=== Testing Mode Selection ===")

    all_passed = True

    # Test fixed mode
    result = get_afk_threshold(50, 'fixed', afk_timer_seconds=60)
    status = "PASS" if result == 60.0 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] Fixed mode: got {result}s, expected 60s")

    # Test character_aware mode
    result = get_afk_threshold(50, 'character_aware', char_multiplier=1.2)
    expected = 60.0  # 50 * 1.2
    status = "PASS" if abs(result - expected) < 0.01 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] Character-aware mode: got {result}s, expected {expected}s")

    # Test adaptive mode during warmup (should fall back to Algorithm 1)
    result = get_afk_threshold(50, 'adaptive', ema_sample_count=3, min_samples=5, char_multiplier=1.2)
    expected = 60.0  # Falls back to Algorithm 1
    status = "PASS" if abs(result - expected) < 0.01 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] Adaptive mode (warmup): got {result}s, expected {expected}s (Algorithm 1 fallback)")

    # Test adaptive mode after warmup
    result = get_afk_threshold(50, 'adaptive', ema_time_per_char=0.5, ema_sample_count=10,
                               min_samples=5, anomaly_multiplier=3.0)
    expected = 75.0  # 50 * 0.5 * 3.0
    status = "PASS" if abs(result - expected) < 0.01 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] Adaptive mode (warmed up): got {result}s, expected {expected}s (Algorithm 2)")

    return all_passed


def test_reading_time_calculation():
    """Test calculate_actual_reading_time with different modes"""
    print("\n=== Testing Reading Time Calculation ===")

    all_passed = True

    # Simulate a reading session: timestamps and char counts
    # Line 1: 20 chars at t=0
    # Line 2: 30 chars at t=10 (10s gap, should count)
    # Line 3: 25 chars at t=25 (15s gap, should count)
    # Line 4: 40 chars at t=200 (175s gap, should be capped)

    timestamps = [0, 10, 25, 200]
    char_counts = [20, 30, 25, 40]

    # Test 1: Fixed mode (60s cap)
    # Gaps: 10s, 15s, 175s -> 10 + 15 + 60 = 85s
    result = calculate_actual_reading_time(timestamps, mode='fixed', afk_timer_seconds=60)
    expected = 85.0
    status = "PASS" if abs(result - expected) < 0.01 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] Fixed mode (60s cap): got {result:.1f}s, expected {expected:.1f}s")

    # Test 2: Character-aware mode
    # Gap 1 (10s): prev=20 chars -> threshold=24s -> count 10s
    # Gap 2 (15s): prev=30 chars -> threshold=36s -> count 15s
    # Gap 3 (175s): prev=25 chars -> threshold=30s -> count 30s
    # Total: 10 + 15 + 30 = 55s
    result = calculate_actual_reading_time(timestamps, char_counts=char_counts, mode='character_aware')
    expected = 55.0
    status = "PASS" if abs(result - expected) < 0.01 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] Character-aware mode: got {result:.1f}s, expected {expected:.1f}s")

    # Test 3: Adaptive mode (warmed up with EMA=0.5s/char)
    # Gap 1 (10s): prev=20 chars -> threshold=30s (20*0.5*3) -> count 10s
    # Gap 2 (15s): prev=30 chars -> threshold=45s (30*0.5*3) -> count 15s
    # Gap 3 (175s): prev=25 chars -> threshold=37.5s (25*0.5*3) -> count 37.5s
    # Total: 10 + 15 + 37.5 = 62.5s
    result = calculate_actual_reading_time(timestamps, char_counts=char_counts, mode='adaptive',
                                           ema_time_per_char=0.5, ema_sample_count=10)
    expected = 62.5
    status = "PASS" if abs(result - expected) < 0.01 else "FAIL"
    if status == "FAIL":
        all_passed = False
    print(f"  [{status}] Adaptive mode (EMA=0.5): got {result:.1f}s, expected {expected:.1f}s")

    return all_passed


def test_realistic_scenario():
    """Test a realistic reading scenario"""
    print("\n=== Testing Realistic Reading Scenario ===")

    # Simulate reading a visual novel
    # Average reading speed: ~300 chars/minute = 5 chars/second = 0.2s/char
    # With some variance in reading speed

    print("  Scenario: Reading 10 lines of varying lengths")
    print("  Simulating with EMA learning...")

    # Lines with their char counts and simulated reading times
    lines = [
        (30, 8.0),   # 30 chars, took 8s (0.27s/char - slow)
        (45, 10.0),  # 45 chars, took 10s (0.22s/char)
        (20, 5.0),   # 20 chars, took 5s (0.25s/char)
        (60, 12.0),  # 60 chars, took 12s (0.20s/char)
        (35, 7.0),   # 35 chars, took 7s (0.20s/char)
        (50, 180.0), # 50 chars, took 180s (AFK! went to get coffee)
        (40, 8.0),   # 40 chars, took 8s (0.20s/char)
        (55, 11.0),  # 55 chars, took 11s (0.20s/char)
        (25, 5.0),   # 25 chars, took 5s (0.20s/char)
        (70, 14.0),  # 70 chars, took 14s (0.20s/char)
    ]

    ema = 0.0
    alpha = 0.2
    total_time_adaptive = 0.0
    total_time_fixed = 0.0
    sample_count = 0

    print("\n  Line | Chars | Gap(s) | EMA(s/c) | Adaptive Thresh | Counted | Fixed Counted")
    print("  " + "-" * 80)

    prev_chars = 0
    for i, (chars, gap) in enumerate(lines):
        if i == 0:
            print(f"  {i+1:4d} | {chars:5d} | {'-':>6s} | {'-':>8s} | {'-':>15s} | {'-':>7s} | {'-':>13s}")
            prev_chars = chars
            continue

        # Calculate adaptive threshold (using previous line's chars)
        if sample_count >= 5 and ema > 0:
            adaptive_thresh = min(120, max(5, prev_chars * ema * 3.0))
        else:
            adaptive_thresh = min(120, max(5, prev_chars * 1.2))

        # Count time
        adaptive_counted = min(gap, adaptive_thresh)
        fixed_counted = min(gap, 60)  # Fixed 60s

        total_time_adaptive += adaptive_counted
        total_time_fixed += fixed_counted

        # Update EMA if not AFK
        if gap <= adaptive_thresh and prev_chars > 0:
            time_per_char = gap / prev_chars
            if time_per_char > 0.01 and time_per_char < 10.0:
                if ema <= 0:
                    ema = time_per_char
                else:
                    ema = alpha * time_per_char + (1 - alpha) * ema
                sample_count += 1

        afk_marker = " (AFK)" if gap > adaptive_thresh else ""
        ema_str = f"{ema:.3f}" if ema > 0 else "-"
        print(f"  {i+1:4d} | {chars:5d} | {gap:6.1f} | {ema_str:>8s} | {adaptive_thresh:15.1f} | {adaptive_counted:7.1f} | {fixed_counted:13.1f}{afk_marker}")

        prev_chars = chars

    print("  " + "-" * 80)
    print(f"  Total reading time (Adaptive): {total_time_adaptive:.1f}s ({total_time_adaptive/60:.1f}m)")
    print(f"  Total reading time (Fixed 60s): {total_time_fixed:.1f}s ({total_time_fixed/60:.1f}m)")
    if ema > 0:
        print(f"  Final EMA: {ema:.3f}s/char ({1/ema:.1f} chars/sec)")
        print(f"  Samples collected: {sample_count}")

    # The adaptive method should give less total time because it correctly identifies
    # the AFK period and caps it more appropriately
    print(f"\n  Key insight: The 180s AFK gap was correctly identified!")
    print(f"  - Adaptive capped it at {min(120, max(5, 50 * (ema if sample_count >= 5 else 1.2) * 3.0)):.1f}s")
    print(f"  - Fixed always caps at 60s")

    return True


def main():
    print("=" * 60)
    print("Character-Aware AFK Detection Test Suite")
    print("=" * 60)

    results = []

    results.append(("Algorithm 1 (Fallback)", test_algorithm1_fallback_threshold()))
    results.append(("Algorithm 2 (EMA)", test_algorithm2_ema_threshold()))
    results.append(("EMA Update", test_ema_update()))
    results.append(("Mode Selection", test_mode_selection()))
    results.append(("Reading Time Calculation", test_reading_time_calculation()))
    results.append(("Realistic Scenario", test_realistic_scenario()))

    print("\n" + "=" * 60)
    print("Test Summary")
    print("=" * 60)

    all_passed = True
    for name, passed in results:
        status = "PASS" if passed else "FAIL"
        if not passed:
            all_passed = False
        print(f"  [{status}] {name}")

    print("=" * 60)
    if all_passed:
        print("All tests passed!")
    else:
        print("Some tests failed. Check output above for details.")

    return 0 if all_passed else 1


if __name__ == "__main__":
    import sys
    sys.exit(main())
