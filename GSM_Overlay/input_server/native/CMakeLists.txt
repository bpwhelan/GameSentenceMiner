cmake_minimum_required(VERSION 3.22.1)

project(gsm_hoshidicts_native LANGUAGES C CXX)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(HOSHIDICTS_CLI OFF CACHE BOOL "" FORCE)
set(HOSHIDICTS_BENCHMARK OFF CACHE BOOL "" FORCE)
set(HOSHIDICTS_TESTS OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(ZSTD_BUILD_STATIC ON CACHE BOOL "" FORCE)
set(LIBDEFLATE_BUILD_SHARED_LIB OFF CACHE BOOL "" FORCE)
set(LIBDEFLATE_BUILD_STATIC_LIB ON CACHE BOOL "" FORCE)
set(LIBDEFLATE_BUILD_GZIP OFF CACHE BOOL "" FORCE)
set(LIBDEFLATE_INSTALL OFF CACHE BOOL "" FORCE)
set(UTF8PROC_INSTALL OFF CACHE BOOL "" FORCE)

add_subdirectory(
    "${CMAKE_CURRENT_LIST_DIR}/../hoshidicts"
    "${CMAKE_CURRENT_BINARY_DIR}/hoshidicts"
)

# The pinned Hoshidicts header uses uint64_t without directly including cstdint.
# Keep the submodule immutable and supply the missing include from this wrapper.
if(MSVC)
    target_compile_options(hoshidicts PRIVATE /FIcstdint /utf-8 /Zc:__cplusplus)
else()
    target_compile_options(hoshidicts PRIVATE -include cstdint)
endif()

install(
    TARGETS
        hoshidicts
        libzstd_static
        libdeflate_static
        utf8proc
    ARCHIVE DESTINATION lib
    LIBRARY DESTINATION lib
    RUNTIME DESTINATION bin
)
