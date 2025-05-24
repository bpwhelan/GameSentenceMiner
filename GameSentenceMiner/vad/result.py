from GameSentenceMiner.configuration import get_config


class VADResult:
    def __init__(self, success: bool, start: float, end: float, model: str):
        self.success = success
        self.start = start
        self.end = end
        self.model = model

    def __repr__(self):
        return f"VADResult(success={self.success}, start={self.start}, end={self.end}, model={self.model})"

    def trim_successful_string(self):
        if self.success:
            if get_config().vad.trim_beginning:
                return f"Trimmed audio from {self.start:.2f} to {self.end:.2f} seconds using {self.model}."
            else:
                return f"Trimmed end of audio to {self.end:.2f} seconds using {self.model}."
        else:
            return f"Failed to trim audio using {self.model}."