! json_example.f90 - JSON handling example for Durable Streams Fortran client
!
! This example demonstrates:
! - Working with JSON arrays
! - Reading JSON data as structured items
! - Parsing JSON responses
!
! Compile with:
!   gfortran -o json_example json_example.f90 -L../lib -ldurable_streams -lcurl

program json_example
    use durable_streams
    implicit none

    type(DurableStream) :: stream
    type(StreamError) :: err
    type(AppendResult) :: result
    type(JsonArray) :: items
    type(JsonValue) :: item
    character(len=256) :: stream_url
    integer :: i

    ! Configuration
    stream_url = "http://localhost:8080/streams/json-test"

    print '(A)', "=== Durable Streams JSON Example ==="
    print '(A)', ""

    ! Initialize and create stream
    call stream%init(trim(stream_url))
    call stream%create(content_type=JSON_CONTENT_TYPE, error=err)
    if (err%code /= DS_OK) then
        print '(A,A)', "Create error: ", trim(err%message)
        call stream%close()
        stop 1
    end if

    print '(A)', "Stream created with JSON content type"
    print '(A)', ""

    ! Build a JSON array using JsonArray
    print '(A)', "Building JSON array..."
    call items%init()

    ! Add various JSON items (as raw JSON strings)
    call items%add_raw('{"type": "event", "name": "start", "timestamp": 1000}')
    call items%add_raw('{"type": "event", "name": "process", "data": {"value": 42}}')
    call items%add_raw('{"type": "event", "name": "end", "timestamp": 2000}')

    print '(A,I0,A)', "Created array with ", items%size(), " items"
    print '(A,A)', "JSON: ", items%to_string()
    print '(A)', ""

    ! Append the array to the stream
    print '(A)', "Appending JSON array to stream..."
    call stream%append(items, result=result, error=err)
    if (err%code /= DS_OK) then
        print '(A,A)', "Append error: ", trim(err%message)
    else
        print '(A,A)', "Appended successfully, offset: ", result%next_offset%to_string()
    end if
    print '(A)', ""

    ! Append individual items
    print '(A)', "Appending individual JSON objects..."
    call stream%append('{"type": "metric", "cpu": 45.2}', result=result, error=err)
    call stream%append('{"type": "metric", "memory": 1024}', result=result, error=err)
    print '(A)', "Done"
    print '(A)', ""

    ! Read back as JSON array
    print '(A)', "Reading all JSON items..."
    call items%clear()
    call stream%read_json(items, start_offset(), err)

    if (err%code /= DS_OK) then
        print '(A,A)', "Read error: ", trim(err%message)
    else
        print '(A,I0,A)', "Read ", items%size(), " items:"
        print '(A)', ""

        do i = 1, items%size()
            item = items%get(i)
            print '(A,I0,A,A)', "Item ", i, ": ", item%to_string()
        end do
    end if
    print '(A)', ""

    ! Cleanup
    print '(A)', "Deleting stream..."
    call stream%delete(err)
    call stream%close()

    print '(A)', ""
    print '(A)', "=== JSON Example completed ==="

end program json_example
