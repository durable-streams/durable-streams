cmake_minimum_required(VERSION 3.16)
project(durable-streams-server C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Compiler flags for release
set(CMAKE_C_FLAGS_RELEASE "-O3 -march=native -flto -ffast-math -DNDEBUG")
set(CMAKE_C_FLAGS_DEBUG "-g -O0 -fsanitize=address,undefined")

# Default to Release build
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Find libmicrohttpd
find_package(PkgConfig REQUIRED)
pkg_check_modules(MHD REQUIRED libmicrohttpd)

# Find pthreads
find_package(Threads REQUIRED)

# Source files
set(SOURCES
    src/ds_store.c
    src/ds_server.c
    src/ds_sse.c
    src/main.c
)

# Include directories
include_directories(
    ${CMAKE_SOURCE_DIR}/include
    ${MHD_INCLUDE_DIRS}
)

# Add definitions
add_definitions(-D_GNU_SOURCE)

# Create executable
add_executable(durable-streams-server ${SOURCES})

# Link libraries
target_link_libraries(durable-streams-server
    ${MHD_LIBRARIES}
    Threads::Threads
    m
)

# Link flags for LTO
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set_property(TARGET durable-streams-server PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()

# Install
install(TARGETS durable-streams-server DESTINATION bin)

# Print build info
message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "C Compiler: ${CMAKE_C_COMPILER}")
message(STATUS "C Flags: ${CMAKE_C_FLAGS}")
message(STATUS "libmicrohttpd: ${MHD_LIBRARIES}")
