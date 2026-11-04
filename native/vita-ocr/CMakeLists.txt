cmake_minimum_required(VERSION 3.20)
project(gsm_vita_ocr LANGUAGES C)

# Prebuilt Windows libraries must work without a separate VC runtime install.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Build separate, explicitly selected AVX2 assets; never use -march=native for releases.
option(VOCR_AVX2 "Build x64 AVX2 kernels (requires a host CPU check before loading)" OFF)
if(VOCR_AVX2 AND NOT CMAKE_SYSTEM_PROCESSOR MATCHES "^(AMD64|amd64|x86_64|x64)$")
    message(FATAL_ERROR "VOCR_AVX2 is only supported for x64 targets")
endif()

# Source files are fetched at a pinned commit and SHA-256 checked by setup_vita_ocr.py.
if(NOT VOCR_SOURCE_DIR)
    message(FATAL_ERROR "Set VOCR_SOURCE_DIR to the verified upstream runtime directory")
endif()
add_library(gsm_vita_ocr SHARED
    features.c
    "${VOCR_SOURCE_DIR}/vocr.c"
    "${VOCR_SOURCE_DIR}/vocr_lines.c"
    "${VOCR_SOURCE_DIR}/vocr_lines_fix.c"
    "${VOCR_SOURCE_DIR}/vocr_charbox.c"
)
set_target_properties(gsm_vita_ocr PROPERTIES
    C_STANDARD 99
    C_STANDARD_REQUIRED YES
    WINDOWS_EXPORT_ALL_SYMBOLS YES
)
if(MSVC)
    target_compile_options(gsm_vita_ocr PRIVATE /O2 /fp:strict /utf-8)
else()
    target_compile_options(gsm_vita_ocr PRIVATE -O3 -ffp-contract=off)
    target_link_libraries(gsm_vita_ocr PRIVATE m)
endif()
if(VOCR_AVX2)
    if(MSVC)
        target_compile_options(gsm_vita_ocr PRIVATE /arch:AVX2)
    else()
        target_compile_options(gsm_vita_ocr PRIVATE -mavx2)
    endif()
endif()
install(TARGETS gsm_vita_ocr RUNTIME DESTINATION . LIBRARY DESTINATION . COMPONENT recognizer)

# A separate library can be installed while the existing recognizer is loaded.
add_library(gsm_vocr_spotter SHARED
    features.c
    spotter_bridge.c
    "${VOCR_SOURCE_DIR}/vocr_lines.c"
    "${VOCR_SOURCE_DIR}/vocr_lines_rows.c"
    "${VOCR_SOURCE_DIR}/vocr_textspot6.c"
)
target_include_directories(gsm_vocr_spotter PRIVATE "${VOCR_SOURCE_DIR}")
set_target_properties(gsm_vocr_spotter PROPERTIES C_STANDARD 99 C_STANDARD_REQUIRED YES WINDOWS_EXPORT_ALL_SYMBOLS YES)
if(MSVC)
    target_compile_options(gsm_vocr_spotter PRIVATE /O2 /fp:strict /utf-8)
else()
    target_compile_options(gsm_vocr_spotter PRIVATE -O3 -ffp-contract=off)
    target_link_libraries(gsm_vocr_spotter PRIVATE m)
endif()
if(VOCR_AVX2)
    if(MSVC)
        target_compile_options(gsm_vocr_spotter PRIVATE /arch:AVX2)
    else()
        target_compile_options(gsm_vocr_spotter PRIVATE -mavx2)
    endif()
endif()
install(TARGETS gsm_vocr_spotter RUNTIME DESTINATION . COMPONENT spotter LIBRARY DESTINATION . COMPONENT spotter)
