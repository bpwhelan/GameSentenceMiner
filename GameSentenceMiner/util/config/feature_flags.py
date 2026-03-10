import functools
from typing import Callable, TypeVar, Any, Optional

from GameSentenceMiner.util.config.configuration import get_master_config, logger

F = TypeVar("F", bound=Callable[..., Any])


def _is_experimental_enabled() -> bool:
    master = get_master_config()
    if not master:
        return False
    experimental = getattr(master, "experimental", None)
    return bool(
        experimental and getattr(experimental, "enable_experimental_features", False)
    )


def is_tokenisation_enabled() -> bool:
    """Check both the master experimental toggle and the tokenisation toggle."""
    if not _is_experimental_enabled():
        return False
    master = get_master_config()
    experimental = getattr(master, "experimental", None)
    return bool(experimental and getattr(experimental, "enable_tokenisation", False))


def is_tokenisation_low_performance() -> bool:
    """Check if tokenisation low-performance throttle mode is enabled."""
    master = get_master_config()
    if not master:
        return False
    experimental = getattr(master, "experimental", None)
    return bool(
        experimental and getattr(experimental, "tokenise_low_performance", False)
    )


def experimental_feature(default_return: Optional[Any] = None):
    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            if not _is_experimental_enabled():
                logger.info("Experimental features disabled; skipping call.")
                return default_return
            return func(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


def process_pausing_feature(default_return: Optional[Any] = None):
    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            master = get_master_config()
            process_cfg = getattr(master, "process_pausing", None) if master else None
            if not process_cfg or not getattr(process_cfg, "enabled", False):
                logger.info("Process pausing disabled; skipping call.")
                return default_return
            return func(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator


def tokenisation_feature(default_return: Optional[Any] = None):
    """Decorator that gates a function behind both experimental + tokenisation toggles."""

    def decorator(func: F) -> F:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            if not is_tokenisation_enabled():
                return default_return
            return func(*args, **kwargs)

        return wrapper  # type: ignore[return-value]

    return decorator
