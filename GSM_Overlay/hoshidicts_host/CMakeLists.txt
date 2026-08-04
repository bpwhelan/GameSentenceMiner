cmake_minimum_required(VERSION 3.22.1)

project(gsm_hoshidicts_host LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
  add_compile_options(
    "$<$<COMPILE_LANGUAGE:CXX>:/utf-8>"
    "$<$<COMPILE_LANGUAGE:CXX>:/Zc:__cplusplus>"
  )
endif()

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/provenance.json" HOSHIDICTS_PROVENANCE)
string(JSON HOSHIDICTS_COMMIT GET "${HOSHIDICTS_PROVENANCE}" source commit)

add_subdirectory(vendor/hoshidicts EXCLUDE_FROM_ALL)

add_library(gsm_hoshidicts_host_core
  src/protocol.cpp
  src/session.cpp
)

target_include_directories(gsm_hoshidicts_host_core PUBLIC src)
target_link_libraries(gsm_hoshidicts_host_core
  PUBLIC hoshidicts
  PRIVATE glaze::glaze
)
target_compile_definitions(gsm_hoshidicts_host_core PUBLIC
  GSM_HOSHIDICTS_COMMIT="${HOSHIDICTS_COMMIT}"
  GSM_HOSHIDICTS_HOST_VERSION="0.1.0"
)

add_executable(gsm_hoshidicts_host src/main.cpp)
target_link_libraries(gsm_hoshidicts_host PRIVATE gsm_hoshidicts_host_core)

if(MSVC)
  target_link_options(gsm_hoshidicts_host PRIVATE
    /MANIFEST:EMBED
    "/MANIFESTINPUT:${CMAKE_CURRENT_SOURCE_DIR}/src/windows_utf8.manifest"
  )
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  target_link_options(gsm_hoshidicts_host PRIVATE -static-libgcc -static-libstdc++)
endif()

if(MSVC)
  target_compile_options(gsm_hoshidicts_host_core PRIVATE /W4 /permissive-)
  target_compile_options(gsm_hoshidicts_host PRIVATE /W4 /permissive-)
else()
  target_compile_options(gsm_hoshidicts_host_core PRIVATE -Wall -Wextra -Wpedantic)
  target_compile_options(gsm_hoshidicts_host PRIVATE -Wall -Wextra -Wpedantic)
endif()

include(CTest)
if(BUILD_TESTING)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)

  set(HOSHIDICTS_FIXTURE_ZIP
    "${CMAKE_CURRENT_BINARY_DIR}/fixtures/gsm-hoshi-fixture.zip"
  )
  file(GLOB_RECURSE HOSHIDICTS_FIXTURE_INPUTS CONFIGURE_DEPENDS
    "${CMAKE_CURRENT_SOURCE_DIR}/fixtures/tiny-yomitan/*"
  )
  add_custom_command(
    OUTPUT "${HOSHIDICTS_FIXTURE_ZIP}"
    COMMAND
      "${Python3_EXECUTABLE}"
      "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/generate_hoshidicts_fixture.py"
      "${HOSHIDICTS_FIXTURE_ZIP}"
    DEPENDS
      "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/generate_hoshidicts_fixture.py"
      ${HOSHIDICTS_FIXTURE_INPUTS}
    VERBATIM
  )
  add_custom_target(hoshidicts-test-fixture ALL
    DEPENDS "${HOSHIDICTS_FIXTURE_ZIP}"
  )

  add_executable(hoshidicts-host-tests tests/host_tests.cpp)
  target_link_libraries(hoshidicts-host-tests PRIVATE gsm_hoshidicts_host_core)
  add_dependencies(hoshidicts-host-tests hoshidicts-test-fixture)
  if(MSVC)
    target_compile_options(hoshidicts-host-tests PRIVATE /W4 /permissive-)
  else()
    target_compile_options(hoshidicts-host-tests PRIVATE -Wall -Wextra -Wpedantic)
  endif()

  add_test(
    NAME hoshidicts-host-tests
    COMMAND hoshidicts-host-tests "${HOSHIDICTS_FIXTURE_ZIP}"
  )
  add_test(
    NAME hoshidicts-host-self-test
    COMMAND gsm_hoshidicts_host --self-test
  )
  add_test(
    NAME hoshidicts-host-version
    COMMAND gsm_hoshidicts_host --version
  )
  set_tests_properties(hoshidicts-host-version PROPERTIES
    PASS_REGULAR_EXPRESSION "${HOSHIDICTS_COMMIT}"
  )

  find_program(NODE_EXECUTABLE node REQUIRED)
  add_test(
    NAME hoshidicts-client-smoke
    COMMAND
      "${NODE_EXECUTABLE}"
      "${CMAKE_CURRENT_SOURCE_DIR}/tests/client_smoke.cjs"
      "$<TARGET_FILE:gsm_hoshidicts_host>"
  )

  add_executable(
    hoshidicts-host-benchmark
    benchmarks/host_benchmark.cpp
  )
  target_link_libraries(
    hoshidicts-host-benchmark
    PRIVATE gsm_hoshidicts_host_core
  )
  add_dependencies(hoshidicts-host-benchmark hoshidicts-test-fixture)
  if(WIN32)
    target_link_libraries(hoshidicts-host-benchmark PRIVATE Psapi)
  endif()
  if(MSVC)
    target_compile_options(hoshidicts-host-benchmark PRIVATE /W4 /permissive-)
  else()
    target_compile_options(hoshidicts-host-benchmark PRIVATE -Wall -Wextra -Wpedantic)
  endif()
  add_test(
    NAME hoshidicts-host-benchmark
    COMMAND hoshidicts-host-benchmark "${HOSHIDICTS_FIXTURE_ZIP}"
  )
  set_tests_properties(
    hoshidicts-client-smoke
    hoshidicts-host-benchmark
    PROPERTIES LABELS performance
  )
endif()
