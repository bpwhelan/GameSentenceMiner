cmake_minimum_required(VERSION 3.24)

project(gsm-windows-speech-recognition LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "The Windows speech recognition helper is only supported on Windows.")
endif()

if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "The embedded Windows speech runtime requires a 64-bit build.")
endif()

include(FetchContent)

set(GSM_SPEECH_SDK_VERSION "1.41.1" CACHE STRING "Microsoft Speech SDK version")

# LunaTranslator uses this SDK version because newer SDK binaries can be
# incompatible with the embedded runtime shipped by Windows Live Captions.
FetchContent_Declare(
    CognitiveServices
    URL https://www.nuget.org/api/v2/package/Microsoft.CognitiveServices.Speech/${GSM_SPEECH_SDK_VERSION}
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(CognitiveServices)

set(COGNITIVE_SERVICES_ROOT "${cognitiveservices_SOURCE_DIR}")
set(COGNITIVE_SERVICES_LIB
    "${COGNITIVE_SERVICES_ROOT}/build/native/x64/Release/Microsoft.CognitiveServices.Speech.core.lib"
)

if(NOT EXISTS "${COGNITIVE_SERVICES_LIB}")
    message(FATAL_ERROR "Microsoft Cognitive Services Speech SDK library was not found at ${COGNITIVE_SERVICES_LIB}")
endif()

add_executable(gsm-windows-speech-recognition main.cpp)
target_compile_features(gsm-windows-speech-recognition PRIVATE cxx_std_17)
target_compile_definitions(gsm-windows-speech-recognition PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_include_directories(
    gsm-windows-speech-recognition
    PRIVATE
        "${COGNITIVE_SERVICES_ROOT}/build/native/include/c_api"
        "${COGNITIVE_SERVICES_ROOT}/build/native/include/cxx_api"
)
target_link_libraries(
    gsm-windows-speech-recognition
    PRIVATE
        "${COGNITIVE_SERVICES_LIB}"
        delayimp
        ole32
        windowsapp
)
target_link_options(
    gsm-windows-speech-recognition
    PRIVATE
        "/DELAYLOAD:Microsoft.CognitiveServices.Speech.core.dll"
)

set_target_properties(
    gsm-windows-speech-recognition
    PROPERTIES
        OUTPUT_NAME "gsm-windows-speech-recognition"
)

add_executable(gsm-windows-speech-recognition-sapi sapi_main.cpp)
target_compile_features(gsm-windows-speech-recognition-sapi PRIVATE cxx_std_17)
target_compile_definitions(gsm-windows-speech-recognition-sapi PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
target_link_libraries(gsm-windows-speech-recognition-sapi PRIVATE ole32 SAPI)
set_target_properties(
    gsm-windows-speech-recognition-sapi
    PROPERTIES
        OUTPUT_NAME "gsm-windows-speech-recognition-sapi"
)
