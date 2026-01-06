! live_read.f90 - Live reading example for Durable Streams Fortran client
!
! This example demonstrates:
! - Connecting to an existing stream
! - Reading with long-poll live mode
! - Using the StreamIterator for continuous reading
!
! Compile with:
!   gfortran -o live_read live_read.f90 -L../lib -ldurable_streams -lcurl

program live_read
    use durable_streams
    implicit none

    type(DurableStream) :: stream
    type(StreamIterator) :: iter
    type(StreamError) :: err
    type(StreamChunk) :: chunk
    type(Offset) :: current_offset
    character(len=256) :: stream_url
    integer :: read_count

    ! Configuration - change this to your stream URL
    stream_url = "http://localhost:8080/streams/live-test"

    print '(A)', "=== Durable Streams Live Reading Example ==="
    print '(A)', ""
    print '(A)', "This example will read from a stream in live mode."
    print '(A)', "Press Ctrl+C to stop."
    print '(A)', ""

    ! Connect to existing stream (or create if needed)
    print '(A,A)', "Connecting to: ", trim(stream_url)
    call stream%init(trim(stream_url))

    ! Try to create (will succeed if doesn't exist, or return existing)
    call stream%create(content_type=JSON_CONTENT_TYPE, error=err)
    if (err%code /= DS_OK .and. err%code /= DS_ERR_CONFLICT_EXISTS) then
        print '(A,A)', "Error: ", trim(err%message)
        call stream%close()
        stop 1
    end if

    print '(A,A)', "Content-Type: ", stream%get_content_type()
    print '(A)', ""

    ! Initialize iterator with long-poll live mode
    print '(A)', "Starting live read with long-poll mode..."
    print '(A)', "(Waiting for data...)"
    print '(A)', ""

    current_offset = start_offset()
    read_count = 0

    ! Read loop using iterator
    call iter%init(stream, current_offset, LIVE_MODE_LONG_POLL)

    do while (.not. iter%closed)
        call iter%next(chunk, err)

        if (err%code /= DS_OK) then
            print '(A,A)', "Read error: ", trim(err%message)
            exit
        end if

        read_count = read_count + 1

        ! Print chunk info
        if (allocated(chunk%data) .and. len(chunk%data) > 0) then
            print '(A,I0,A)', "--- Chunk ", read_count, " ---"
            print '(A,A)', "Offset: ", chunk%next_offset%to_string()
            print '(A,L1)', "Up-to-date: ", chunk%up_to_date
            print '(A)', "Data:"
            print '(A)', trim(chunk%data)
            print '(A)', ""
        else
            print '(A,I0,A)', "--- Chunk ", read_count, " (empty, timeout) ---"
            print '(A,L1)', "Up-to-date: ", chunk%up_to_date
            print '(A)', ""
        end if

        ! Limit reads for demo (remove in production)
        if (read_count >= 10) then
            print '(A)', "Reached 10 reads, stopping demo."
            exit
        end if
    end do

    ! Cleanup
    call iter%close()
    call stream%close()

    print '(A)', ""
    print '(A)', "=== Live reading stopped ==="

end program live_read
