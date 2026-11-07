import threading

from GameSentenceMiner.util.config.configuration import logger
from GameSentenceMiner.util.gpu_runtime import get_diagnostics, record_runtime, should_use_gpu


class SharedMeikiOCRModel:
    """
    Lazily shares the selected MeikiOCR pipeline, replacing it after a model change.
    """

    _lock = threading.Lock()
    _model = None
    _model_key = None
    _device = "cpu"
    _init_attempted = False
    _init_error: Exception | None = None

    @classmethod
    def _detect_device(cls, force_cpu: bool = False) -> str:
        if force_cpu:
            return "cpu"
        try:
            if should_use_gpu("meiki"):
                return "cuda"
        except Exception:
            return "cpu"
        return "cpu"

    @staticmethod
    def _preload_onnxruntime_dlls() -> None:
        # Explicit system-first loading avoids ONNX's default preference for
        # CUDA libraries bundled with Python packages.
        get_diagnostics()

    @classmethod
    def _create_model(cls, *, device: str, model_name: str, model_path: str | None = None):
        from GameSentenceMiner.ocr.meiki_models import MeikiOCRPipeline

        provider = "CUDAExecutionProvider" if device == "cuda" else "CPUExecutionProvider"

        return MeikiOCRPipeline(model_name=model_name, provider=provider, max_batch_size=8)

    @classmethod
    def get_model(cls, force_cpu: bool = False, model_path: str | None = None):
        from GameSentenceMiner.ocr.meiki_model_manager import get_selected_model, get_selection_path

        with cls._lock:
            try:
                model_name = get_selected_model()
            except (OSError, ValueError, TypeError) as error:
                cls._init_error = error
                return None
            try:
                revision = get_selection_path().stat().st_mtime_ns
            except FileNotFoundError:
                revision = None
            key = (model_name, revision, force_cpu, model_path)
            if cls._model_key == key:
                if cls._model is not None:
                    return cls._model
                if cls._init_attempted:
                    return None

            cls._model_key = key
            cls._model = None
            cls._init_attempted = True
            cls._init_error = None
            cls._device = cls._detect_device(force_cpu=force_cpu)
            if cls._device == "cuda":
                cls._preload_onnxruntime_dlls()

            gpu_error = ""
            try:
                cls._model = cls._create_model(device=cls._device, model_name=model_name, model_path=model_path)
            except Exception as e:
                if cls._device != "cpu":
                    gpu_error = str(e)
                    logger.warning(f"Failed to initialize MeikiOCR on {cls._device}: {e}. Retrying on cpu.")
                    try:
                        cls._model = cls._create_model(device="cpu", model_name=model_name, model_path=model_path)
                        cls._device = "cpu"
                    except Exception as cpu_error:
                        cls._init_error = cpu_error
                        logger.warning(f"Error initializing MeikiOCR shared model: {cpu_error}")
                        return None
                else:
                    cls._init_error = e
                    logger.warning(f"Error initializing MeikiOCR shared model: {e}")
                    return None

            logger.info(f"MeikiOCR shared model ready (detector={model_name}, device={cls._device})")
            record_runtime("meiki", cls._device, error=gpu_error)
            return cls._model

    @classmethod
    def get_init_error(cls) -> Exception | None:
        return cls._init_error

    @classmethod
    def run(cls, model, method, *args, **kwargs):
        try:
            return getattr(model, method)(*args, **kwargs)
        except Exception as error:  # noqa: BLE001 - ONNX provider errors have multiple exception classes.
            if getattr(model, "active_provider", "CPUExecutionProvider") != "CUDAExecutionProvider":
                raise
            with cls._lock:
                current = cls._model is model
                if current:
                    replacement = cls._create_model(device="cpu", model_name=model.model_name)
                    cls._model = replacement
                    cls._device = "cpu"
                elif cls._device == "cpu" and getattr(cls._model, "model_name", None) == model.model_name:
                    replacement = cls._model
                else:
                    # An old in-flight scan must not replace a newer selection.
                    replacement = cls._create_model(device="cpu", model_name=model.model_name)
            logger.warning(f"MeikiOCR GPU inference failed; retrying on CPU: {error}")
            if current:
                record_runtime("meiki", "cpu", error=str(error))
            return getattr(replacement, method)(*args, **kwargs)
