! test_stream.f90 - Basic tests for Durable Streams Fortran client
!
! This test module provides basic unit tests for the durable_streams library.
! Tests cover:
! - Offset handling
! - JSON parsing
! - Error handling
!
! Compile with:
!   gfortran -o test_stream test_stream.f90 -L../lib -ldurable_streams -lcurl

program test_stream
    use durable_streams
    implicit none

    integer :: passed, failed, total

    passed = 0
    failed = 0
    total = 0

    print '(A)', "=== Durable Streams Fortran Client Tests ==="
    print '(A)', ""

    ! Offset tests
    call test_offset_start()
    call test_offset_from_string()
    call test_offset_is_valid()

    ! JSON tests
    call test_json_array_init()
    call test_json_array_add_items()
    call test_json_array_to_string()
    call test_json_escape_string()
    call test_json_wrap_value()
    call test_json_parse_array()
    call test_json_extract_field()

    ! Error tests
    call test_error_codes()
    call test_error_from_status()

    ! Summary
    print '(A)', ""
    print '(A)', "=== Test Summary ==="
    print '(A,I0,A,I0)', "Passed: ", passed, " / ", total
    print '(A,I0)', "Failed: ", failed

    if (failed > 0) then
        stop 1
    end if

contains

    subroutine assert_true(condition, test_name)
        logical, intent(in) :: condition
        character(len=*), intent(in) :: test_name

        total = total + 1
        if (condition) then
            passed = passed + 1
            print '(A,A)', "[PASS] ", test_name
        else
            failed = failed + 1
            print '(A,A)', "[FAIL] ", test_name
        end if
    end subroutine assert_true

    subroutine assert_equal_str(actual, expected, test_name)
        character(len=*), intent(in) :: actual, expected, test_name

        total = total + 1
        if (trim(actual) == trim(expected)) then
            passed = passed + 1
            print '(A,A)', "[PASS] ", test_name
        else
            failed = failed + 1
            print '(A,A)', "[FAIL] ", test_name
            print '(A,A)', "       Expected: ", trim(expected)
            print '(A,A)', "       Actual:   ", trim(actual)
        end if
    end subroutine assert_equal_str

    subroutine assert_equal_int(actual, expected, test_name)
        integer, intent(in) :: actual, expected
        character(len=*), intent(in) :: test_name

        total = total + 1
        if (actual == expected) then
            passed = passed + 1
            print '(A,A)', "[PASS] ", test_name
        else
            failed = failed + 1
            print '(A,A)', "[FAIL] ", test_name
            print '(A,I0)', "       Expected: ", expected
            print '(A,I0)', "       Actual:   ", actual
        end if
    end subroutine assert_equal_int

    ! --- Offset Tests ---

    subroutine test_offset_start()
        type(Offset) :: off

        print '(A)', ""
        print '(A)', "--- Offset Tests ---"

        off = start_offset()
        call assert_true(off%is_start(), "start_offset() creates start offset")
        call assert_equal_str(off%to_string(), "-1", "start_offset() has value -1")
    end subroutine test_offset_start

    subroutine test_offset_from_string()
        type(Offset) :: off

        off = Offset("abc123")
        call assert_equal_str(off%to_string(), "abc123", "Offset from string preserves value")
        call assert_true(.not. off%is_start(), "Non-start offset is_start() returns false")
    end subroutine test_offset_from_string

    subroutine test_offset_is_valid()
        type(Offset) :: off1, off2

        off1 = start_offset()
        call assert_true(off1%is_valid(), "start_offset is valid")

        ! off2 is uninitialized
        call assert_true(.not. off2%is_valid(), "uninitialized offset is not valid")
    end subroutine test_offset_is_valid

    ! --- JSON Tests ---

    subroutine test_json_array_init()
        type(JsonArray) :: arr

        print '(A)', ""
        print '(A)', "--- JSON Tests ---"

        call arr%init()
        call assert_equal_int(arr%size(), 0, "new array has size 0")
    end subroutine test_json_array_init

    subroutine test_json_array_add_items()
        type(JsonArray) :: arr

        call arr%init()
        call arr%add_string("hello")
        call arr%add_number(42.0d0)
        call arr%add_bool(.true.)
        call arr%add_null()

        call assert_equal_int(arr%size(), 4, "array has 4 items after adding")
    end subroutine test_json_array_add_items

    subroutine test_json_array_to_string()
        type(JsonArray) :: arr
        character(len=:), allocatable :: json

        call arr%init()
        call arr%add_raw('{"a":1}')
        call arr%add_raw('{"b":2}')

        json = arr%to_string()
        call assert_equal_str(json, '[{"a":1},{"b":2}]', "array to_string produces valid JSON")
    end subroutine test_json_array_to_string

    subroutine test_json_escape_string()
        character(len=:), allocatable :: result

        result = json_escape_string('hello "world"')
        call assert_equal_str(result, 'hello \"world\"', "escapes double quotes")

        result = json_escape_string("line1" // char(10) // "line2")
        call assert_equal_str(result, "line1\nline2", "escapes newlines")
    end subroutine test_json_escape_string

    subroutine test_json_wrap_value()
        character(len=:), allocatable :: result

        ! Single value gets wrapped
        result = json_wrap_value('{"a":1}')
        call assert_equal_str(result, '[{"a":1}]', "wraps single object in array")

        ! Array stays as-is
        result = json_wrap_value('[{"a":1}]')
        call assert_equal_str(result, '[{"a":1}]', "array is not double-wrapped")
    end subroutine test_json_wrap_value

    subroutine test_json_parse_array()
        type(JsonArray) :: arr
        integer :: err

        call json_parse_array('[{"a":1},{"b":2},{"c":3}]', arr, err)
        call assert_equal_int(err, 0, "parse array returns no error")
        call assert_equal_int(arr%size(), 3, "parsed array has 3 items")
    end subroutine test_json_parse_array

    subroutine test_json_extract_field()
        character(len=:), allocatable :: result

        result = json_extract_string_field('{"name":"test","value":123}', "name")
        call assert_equal_str(result, "test", "extracts string field correctly")

        result = json_extract_string_field('{"streamNextOffset":"abc123"}', "streamNextOffset")
        call assert_equal_str(result, "abc123", "extracts offset field correctly")
    end subroutine test_json_extract_field

    ! --- Error Tests ---

    subroutine test_error_codes()
        print '(A)', ""
        print '(A)', "--- Error Tests ---"

        call assert_equal_int(DS_OK, 0, "DS_OK is 0")
        call assert_true(DS_ERR_NOT_FOUND > 0, "DS_ERR_NOT_FOUND is positive")
        call assert_true(DS_ERR_CONFLICT_SEQ > 0, "DS_ERR_CONFLICT_SEQ is positive")
    end subroutine test_error_codes

    subroutine test_error_from_status()
        type(StreamError) :: err

        err = ds_error_from_status(404, "read", "http://test")
        call assert_equal_int(err%code, DS_ERR_NOT_FOUND, "404 maps to NOT_FOUND")

        err = ds_error_from_status(409, "append", "http://test")
        call assert_equal_int(err%code, DS_ERR_CONFLICT_SEQ, "409 maps to CONFLICT_SEQ")

        err = ds_error_from_status(429, "append", "http://test")
        call assert_equal_int(err%code, DS_ERR_RATE_LIMITED, "429 maps to RATE_LIMITED")

        err = ds_error_from_status(200, "read", "http://test")
        call assert_equal_int(err%code, DS_OK, "200 maps to OK")
    end subroutine test_error_from_status

end program test_stream
