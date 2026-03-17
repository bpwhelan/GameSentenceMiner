# shim gsm_ocr
if __name__ == "__main__":
    import runpy

    runpy.run_module("GameSentenceMiner.ocr.gsm_ocr", run_name="__main__", alter_sys=True)
