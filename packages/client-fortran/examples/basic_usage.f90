! basic_usage.f90 - Basic usage example for Durable Streams Fortran client
!
! This example demonstrates:
! - Creating a stream
! - Appending data
! - Reading data
! - Deleting a stream
!
! Compile with:
!   gfortran -o basic_usage basic_usage.f90 -L../lib -ldurable_streams -lcurl

program basic_usage
    use durable_streams
    implicit none

    type(DurableStream) :: stream
    type(StreamError) :: err
    type(AppendResult) :: append_result
    type(StreamMetadata) :: metadata
    type(StreamChunk) :: chunk
    character(len=:), allocatable :: all_data
    character(len=256) :: stream_url

    ! Configuration - change this to your stream URL
    stream_url = "http://localhost:8080/streams/fortran-test"

    print '(A)', "=== Durable Streams Fortran Client Example ==="
    print '(A)', ""

    ! Initialize stream handle
    print '(A)', "1. Initializing stream handle..."
    call stream%init(trim(stream_url))
    print '(A,A)', "   URL: ", stream%get_url()

    ! Create the stream with JSON content type
    print '(A)', ""
    print '(A)', "2. Creating stream..."
    call stream%create(content_type=JSON_CONTENT_TYPE, error=err)
    if (err%code /= DS_OK) then
        print '(A,A)', "   Error: ", trim(err%message)
        call stream%close()
        stop 1
    end if
    print '(A)', "   Stream created successfully!"

    ! Get stream metadata
    print '(A)', ""
    print '(A)', "3. Getting stream metadata..."
    call stream%head(metadata, err)
    if (err%code == DS_OK) then
        print '(A,A)', "   Content-Type: ", trim(metadata%content_type)
        print '(A,A)', "   Next-Offset: ", metadata%next_offset%to_string()
    else
        print '(A,A)', "   Warning: ", trim(err%message)
    end if

    ! Append some JSON data
    print '(A)', ""
    print '(A)', "4. Appending data..."

    call stream%append('{"event": "user_login", "user": "alice"}', result=append_result, error=err)
    if (err%code /= DS_OK) then
        print '(A,A)', "   Error appending: ", trim(err%message)
    else
        print '(A,A)', "   Appended message 1, offset: ", append_result%next_offset%to_string()
    end if

    call stream%append('{"event": "user_action", "action": "click"}', result=append_result, error=err)
    if (err%code /= DS_OK) then
        print '(A,A)', "   Error appending: ", trim(err%message)
    else
        print '(A,A)', "   Appended message 2, offset: ", append_result%next_offset%to_string()
    end if

    call stream%append('{"event": "user_logout", "user": "alice"}', result=append_result, error=err)
    if (err%code /= DS_OK) then
        print '(A,A)', "   Error appending: ", trim(err%message)
    else
        print '(A,A)', "   Appended message 3, offset: ", append_result%next_offset%to_string()
    end if

    ! Read a single chunk
    print '(A)', ""
    print '(A)', "5. Reading single chunk from start..."
    call stream%read(chunk, start_offset(), error=err)
    if (err%code == DS_OK) then
        print '(A,A)', "   Data: ", trim(chunk%data)
        print '(A,A)', "   Next-Offset: ", chunk%next_offset%to_string()
        print '(A,L1)', "   Up-to-date: ", chunk%up_to_date
    else
        print '(A,A)', "   Error: ", trim(err%message)
    end if

    ! Read all data
    print '(A)', ""
    print '(A)', "6. Reading all data..."
    call stream%read_all(all_data, start_offset(), err)
    if (err%code == DS_OK) then
        print '(A,I0,A)', "   Read ", len(all_data), " bytes"
        print '(A,A)', "   Content: ", trim(all_data)
    else
        print '(A,A)', "   Error: ", trim(err%message)
    end if

    ! Delete the stream
    print '(A)', ""
    print '(A)', "7. Deleting stream..."
    call stream%delete(err)
    if (err%code == DS_OK) then
        print '(A)', "   Stream deleted successfully!"
    else
        print '(A,A)', "   Error: ", trim(err%message)
    end if

    ! Cleanup
    print '(A)', ""
    print '(A)', "8. Cleaning up..."
    call stream%close()
    print '(A)', "   Done!"

    print '(A)', ""
    print '(A)', "=== Example completed ==="

end program basic_usage
