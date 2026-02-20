import importlib
import threading
from typing import Optional

from GameSentenceMiner.util.config.configuration import is_cuda_available, logger


class SharedMeikiOCRModel:
    """
    Lazily initializes and stores a single MeikiOCR model instance.
    """

    _lock = threading.Lock()
    _model = None
    _device = "cpu"
    _init_attempted = False
    _init_error: Optional[Exception] = None

    @classmethod
    def _detect_device(cls, force_cpu: bool = False) -> str:
        if force_cpu:
            return "cpu"
        try:
            if is_cuda_available():
                return "cuda"
        except Exception:
            return "cpu"
        return "cpu"

    @staticmethod
    def _preload_onnxruntime_dlls() -> None:
        try:
            import onnxruntime as ort
        except Exception:
            return
        preload_dlls = getattr(ort, "preload_dlls", None)
        if callable(preload_dlls):
            try:
                preload_dlls(directory="")
            except Exception:
                # Preloading is best-effort only.
                return

    @classmethod
    def _create_model(cls, *, device: str, model_path: Optional[str] = None):
        from meikiocr import MeikiOCR
        
        provider = "CUDAExecutionProvider" if device == "cuda" else "CPUExecutionProvider"

        try:
            return MeikiOCR(provider=provider, max_batch_size=8)
        except TypeError:
            # Support older meikiocr signatures that do not accept `device`.
            legacy_kwargs = {}
            if model_path:
                legacy_kwargs["model_path"] = model_path
            return MeikiOCR(**legacy_kwargs)

    @classmethod
    def get_model(cls, force_cpu: bool = False, model_path: Optional[str] = None):
        with cls._lock:
            if cls._model is not None:
                return cls._model
            if cls._init_attempted:
                return None

            cls._init_attempted = True
            cls._init_error = None
            cls._preload_onnxruntime_dlls()
            cls._device = cls._detect_device(force_cpu=force_cpu)

            try:
                cls._model = cls._create_model(device=cls._device, model_path=model_path)
            except Exception as e:
                if cls._device != "cpu":
                    logger.warning(
                        f"Failed to initialize MeikiOCR on {cls._device}: {e}. Retrying on cpu."
                    )
                    try:
                        cls._model = cls._create_model(device="cpu", model_path=model_path)
                        cls._device = "cpu"
                    except Exception as cpu_error:
                        cls._init_error = cpu_error
                        logger.warning(f"Error initializing MeikiOCR shared model: {cpu_error}")
                        return None
                else:
                    cls._init_error = e
                    logger.warning(f"Error initializing MeikiOCR shared model: {e}")
                    return None

            logger.info(f"MeikiOCR shared model ready (device={cls._device})")
            return cls._model

    @classmethod
    def get_init_error(cls) -> Optional[Exception]:
        return cls._init_error
