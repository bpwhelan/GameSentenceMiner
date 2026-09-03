from scripts.verify_python_dependency_policy import get_policy_violations


def test_python_dependency_policy_is_consistent():
    assert get_policy_violations() == []
