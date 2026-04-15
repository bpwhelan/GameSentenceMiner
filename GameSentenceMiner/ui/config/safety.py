from __future__ import annotations

import copy
import functools
import inspect
import types
from typing import Any, Callable, Union, get_args, get_origin, get_type_hints

from GameSentenceMiner.util.config.configuration import logger

_MISSING = object()


def _default_from_annotation(annotation: Any) -> Any:
    if annotation in (inspect.Signature.empty, Any, None, type(None)):
        return None
    if annotation in (bool, int, float, str, bytes, list, tuple, dict, set):
        return annotation()

    origin = get_origin(annotation)
    if origin in (list, tuple, dict, set):
        return origin()
    if origin in (types.UnionType, Union):
        for arg in get_args(annotation):
            if arg is type(None):
                continue
            fallback = _default_from_annotation(arg)
            if fallback is not None or arg in (bool, int, float, str, bytes, list, tuple, dict, set):
                return fallback

    return None


def _default_for_callable(target: Callable[..., Any]) -> Any:
    try:
        annotation = get_type_hints(target).get("return", inspect.Signature.empty)
    except Exception:
        annotation = inspect.signature(target).return_annotation
    return _default_from_annotation(annotation)


def _resolve_default(target: Callable[..., Any], default: Any) -> Any:
    if default is _MISSING:
        return _default_for_callable(target)
    try:
        return copy.deepcopy(default)
    except Exception:
        return default


def _adapt_callable(target: Callable[..., Any]) -> Callable[..., Any]:
    try:
        signature = inspect.signature(target)
    except (TypeError, ValueError):
        return target

    parameters = list(signature.parameters.values())
    max_args = None
    if not any(param.kind == inspect.Parameter.VAR_POSITIONAL for param in parameters):
        max_args = len(
            [
                param
                for param in parameters
                if param.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
            ]
        )
    accepts_kwargs = any(param.kind == inspect.Parameter.VAR_KEYWORD for param in parameters)
    accepted_keywords = {
        param.name
        for param in parameters
        if param.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
    }

    @functools.wraps(target)
    def adapted(*args: Any, **kwargs: Any) -> Any:
        positional_args = args if max_args is None else args[:max_args]
        keyword_args = (
            kwargs if accepts_kwargs else {key: value for key, value in kwargs.items() if key in accepted_keywords}
        )
        return target(*positional_args, **keyword_args)

    return adapted


def safe_config_call(
    func: Callable[..., Any] | None = None,
    *,
    name: str | None = None,
    default: Any = _MISSING,
):
    def decorator(target: Callable[..., Any]) -> Callable[..., Any]:
        if getattr(target, "__gsm_config_safe__", False):
            return target
        adapted_target = _adapt_callable(target)

        @functools.wraps(target)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            try:
                return adapted_target(*args, **kwargs)
            except Exception as exc:
                logger.error(f"Config GUI error in {name or target.__qualname__}: {exc}", exc_info=True)
                return _resolve_default(target, default)

        wrapped.__gsm_config_safe__ = True
        return wrapped

    if func is not None:
        return decorator(func)
    return decorator


def safe_config_callback(
    callback: Callable[..., Any],
    *,
    name: str | None = None,
    default: Any = _MISSING,
) -> Callable[..., Any]:
    return safe_config_call(callback, name=name, default=default)


def safe_config_methods(
    *,
    skip: set[str] | None = None,
    fallbacks: dict[str, Any] | None = None,
):
    skip_names = {"__init__"}
    skip_names.update(skip or set())
    fallback_map = fallbacks or {}

    def decorate_class(cls):
        for attr_name, member in list(vars(cls).items()):
            if attr_name in skip_names:
                continue

            descriptor_type = None
            function = member
            if isinstance(member, staticmethod):
                descriptor_type = staticmethod
                function = member.__func__
            elif isinstance(member, classmethod):
                descriptor_type = classmethod
                function = member.__func__
            elif not inspect.isfunction(member):
                continue

            wrapped = safe_config_call(
                function,
                name=f"{cls.__name__}.{attr_name}",
                default=fallback_map.get(attr_name, _MISSING),
            )
            if descriptor_type is staticmethod:
                wrapped = staticmethod(wrapped)
            elif descriptor_type is classmethod:
                wrapped = classmethod(wrapped)
            setattr(cls, attr_name, wrapped)
        return cls

    return decorate_class
