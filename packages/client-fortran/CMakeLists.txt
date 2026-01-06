# CMakeLists.txt for Durable Streams Fortran Client
#
# Build instructions:
#   mkdir build && cd build
#   cmake ..
#   make
#
# This will create:
#   - libdurable_streams.a (static library)
#   - examples (basic_usage, live_read, json_example)
#   - test_stream (test executable)

cmake_minimum_required(VERSION 3.12)
project(durable_streams_fortran
    VERSION 1.0.0
    LANGUAGES Fortran
)

# Set Fortran standard
set(CMAKE_Fortran_MODULE_DIRECTORY ${CMAKE_BINARY_DIR}/modules)

# Find CURL library
find_package(CURL REQUIRED)

# Compiler flags
if(CMAKE_Fortran_COMPILER_ID MATCHES "GNU")
    set(CMAKE_Fortran_FLAGS "${CMAKE_Fortran_FLAGS} -std=f2008 -Wall -Wextra")
    set(CMAKE_Fortran_FLAGS_DEBUG "-g -fcheck=all -fbacktrace")
    set(CMAKE_Fortran_FLAGS_RELEASE "-O3")
elseif(CMAKE_Fortran_COMPILER_ID MATCHES "Intel")
    set(CMAKE_Fortran_FLAGS "${CMAKE_Fortran_FLAGS} -stand f08 -warn all")
    set(CMAKE_Fortran_FLAGS_DEBUG "-g -check all -traceback")
    set(CMAKE_Fortran_FLAGS_RELEASE "-O3")
endif()

# Source files (in dependency order)
set(LIB_SOURCES
    src/ds_constants.f90
    src/ds_errors.f90
    src/ds_curl.f90
    src/ds_json.f90
    src/ds_types.f90
    src/ds_http.f90
    src/durable_streams.f90
)

# Create static library
add_library(durable_streams STATIC ${LIB_SOURCES})
target_include_directories(durable_streams PUBLIC
    ${CMAKE_BINARY_DIR}/modules
    ${CURL_INCLUDE_DIRS}
)
target_link_libraries(durable_streams PUBLIC ${CURL_LIBRARIES})

# Examples
add_executable(basic_usage examples/basic_usage.f90)
target_link_libraries(basic_usage durable_streams ${CURL_LIBRARIES})

add_executable(live_read examples/live_read.f90)
target_link_libraries(live_read durable_streams ${CURL_LIBRARIES})

add_executable(json_example examples/json_example.f90)
target_link_libraries(json_example durable_streams ${CURL_LIBRARIES})

# Tests
enable_testing()

add_executable(test_stream test/test_stream.f90)
target_link_libraries(test_stream durable_streams ${CURL_LIBRARIES})

add_test(NAME unit_tests COMMAND test_stream)

# Install targets
install(TARGETS durable_streams
    ARCHIVE DESTINATION lib
    LIBRARY DESTINATION lib
)

install(DIRECTORY ${CMAKE_Fortran_MODULE_DIRECTORY}/
    DESTINATION include/durable_streams
    FILES_MATCHING PATTERN "*.mod"
)

# Print configuration summary
message(STATUS "")
message(STATUS "Durable Streams Fortran Client Configuration:")
message(STATUS "  Version: ${PROJECT_VERSION}")
message(STATUS "  Fortran Compiler: ${CMAKE_Fortran_COMPILER_ID} ${CMAKE_Fortran_COMPILER_VERSION}")
message(STATUS "  CURL: ${CURL_LIBRARIES}")
message(STATUS "  Build Type: ${CMAKE_BUILD_TYPE}")
message(STATUS "")
