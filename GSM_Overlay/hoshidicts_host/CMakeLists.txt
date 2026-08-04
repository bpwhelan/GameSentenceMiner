cmake_minimum_required(VERSION 3.22.1)

project(gsm_hoshidicts_host LANGUAGES C CXX)

if(MSVC)
  add_compile_options(
    "$<$<COMPILE_LANGUAGE:CXX>:/utf-8>"
    "$<$<COMPILE_LANGUAGE:CXX>:/Zc:__cplusplus>"
  )
endif()

add_subdirectory(vendor/hoshidicts)
