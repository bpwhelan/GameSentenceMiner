# shim ocr_main
if __name__ == "__main__":
    import runpy
    runpy.run_module("GameSentenceMiner.ocr.ocr_main", run_name="__main__", alter_sys=True)
