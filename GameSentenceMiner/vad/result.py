class VADResult:
    def __init__(self, success: bool, start: float, end: float):
        self.success = success
        self.start = start
        self.end = end

    def __repr__(self):
        return f"VADResult(success={self.success}, start={self.start}, end={self.end})"