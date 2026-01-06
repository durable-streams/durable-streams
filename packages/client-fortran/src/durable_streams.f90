! durable_streams - Main module
! Fortran client library for Durable Streams
!
! This module provides a complete client implementation for the Durable Streams
! protocol, similar to the TypeScript, Go, and Python clients.
!
! Basic usage:
!   use durable_streams
!   type(DurableStream) :: stream
!   type(StreamError) :: err
!
!   call stream%init("https://example.com/streams/my-stream")
!   call stream%create(content_type="application/json", error=err)
!   call stream%append('{"message": "hello"}', error=err)
!   call stream%close()
!
module durable_streams
    use ds_constants
    use ds_errors
    use ds_types
    use ds_json
    use ds_http
    implicit none
    private

    ! Re-export public types and constants
    public :: DS_VERSION
    public :: START_OFFSET
    public :: LIVE_MODE_NONE, LIVE_MODE_AUTO, LIVE_MODE_LONG_POLL, LIVE_MODE_SSE
    public :: JSON_CONTENT_TYPE, DEFAULT_CONTENT_TYPE

    ! Re-export error types and codes
    public :: StreamError
    public :: DS_OK, DS_ERR_NOT_FOUND, DS_ERR_CONFLICT_SEQ, DS_ERR_CONFLICT_EXISTS
    public :: DS_ERR_CONTENT_TYPE_MISMATCH, DS_ERR_BAD_REQUEST, DS_ERR_UNAUTHORIZED
    public :: DS_ERR_FORBIDDEN, DS_ERR_RATE_LIMITED, DS_ERR_OFFSET_GONE
    public :: DS_ERR_NETWORK, DS_ERR_TIMEOUT, DS_ERR_CURL, DS_ERR_JSON_PARSE
    public :: DS_ERR_SSE_NOT_SUPPORTED, DS_ERR_ALREADY_CLOSED, DS_ERR_UNKNOWN

    ! Re-export data types
    public :: Offset, start_offset
    public :: AppendResult, StreamMetadata, StreamChunk
    public :: CreateOptions, AppendOptions, ReadOptions

    ! Re-export JSON types for convenience
    public :: JsonArray, JsonValue

    !> Durable Stream handle
    type, public :: DurableStream
        private
        character(len=:), allocatable :: url
        character(len=:), allocatable :: content_type
        type(HttpClient) :: http
        logical :: initialized = .false.
        logical :: closed = .false.
        ! Custom headers (name:value pairs)
        character(len=512), allocatable :: custom_headers(:)
        integer :: num_headers = 0
    contains
        ! Initialization
        procedure :: init => stream_init
        procedure :: close => stream_close

        ! Static-like factory methods
        procedure :: connect => stream_connect

        ! Core operations
        procedure :: create => stream_create
        procedure :: append_bytes => stream_append_bytes
        procedure :: append_json => stream_append_json
        generic :: append => append_bytes, append_json
        procedure :: delete => stream_delete
        procedure :: head => stream_head

        ! Read operations
        procedure :: read => stream_read
        procedure :: read_all => stream_read_all
        procedure :: read_json => stream_read_json

        ! Utility
        procedure :: get_url => stream_get_url
        procedure :: get_content_type => stream_get_content_type
        procedure :: is_json => stream_is_json
        procedure :: add_header => stream_add_header

        ! Private helpers
        procedure, private :: build_request_headers => stream_build_request_headers
        procedure, private :: extract_response_metadata => stream_extract_response_metadata
    end type DurableStream

    !> Stream iterator for reading chunks
    type, public :: StreamIterator
        private
        type(DurableStream), pointer :: stream => null()
        type(Offset) :: current_offset
        integer :: live_mode = LIVE_MODE_NONE
        character(len=256) :: cursor = ""
        logical :: up_to_date = .false.
        logical :: closed = .false.
    contains
        procedure :: init => iterator_init
        procedure :: next => iterator_next
        procedure :: close => iterator_close
        procedure :: get_offset => iterator_get_offset
        procedure :: is_up_to_date => iterator_is_up_to_date
    end type StreamIterator

contains

    !=========================================================================
    ! DurableStream methods
    !=========================================================================

    !> Initialize a DurableStream handle
    subroutine stream_init(self, url)
        class(DurableStream), intent(inout) :: self
        character(len=*), intent(in) :: url

        self%url = trim(url)
        call self%http%init()
        self%initialized = .true.
        self%closed = .false.
        self%num_headers = 0
        if (allocated(self%custom_headers)) deallocate(self%custom_headers)
        allocate(self%custom_headers(16))
    end subroutine stream_init

    !> Close the stream handle and release resources
    subroutine stream_close(self)
        class(DurableStream), intent(inout) :: self

        if (self%initialized) then
            call self%http%cleanup()
            self%initialized = .false.
            self%closed = .true.
        end if
    end subroutine stream_close

    !> Connect to an existing stream (HEAD to verify and get content-type)
    subroutine stream_connect(self, url, error)
        class(DurableStream), intent(inout) :: self
        character(len=*), intent(in) :: url
        type(StreamError), intent(out), optional :: error
        type(StreamMetadata) :: metadata
        type(StreamError) :: local_error

        call self%init(url)
        call self%head(metadata, local_error)

        if (local_error%code == DS_OK) then
            self%content_type = trim(metadata%content_type)
        end if

        if (present(error)) error = local_error
    end subroutine stream_connect

    !> Create a new stream (PUT)
    subroutine stream_create(self, content_type, ttl_seconds, expires_at, initial_data, error)
        class(DurableStream), intent(inout) :: self
        character(len=*), intent(in), optional :: content_type
        integer, intent(in), optional :: ttl_seconds
        character(len=*), intent(in), optional :: expires_at
        character(len=*), intent(in), optional :: initial_data
        type(StreamError), intent(out), optional :: error
        type(HttpResponse) :: response
        character(len=512), allocatable :: headers(:)
        integer :: n_headers
        character(len=32) :: ttl_str

        if (.not. self%initialized) then
            if (present(error)) then
                error%code = DS_ERR_ALREADY_CLOSED
                error%message = "Stream not initialized"
            end if
            return
        end if

        ! Build headers
        n_headers = self%num_headers
        if (present(content_type)) n_headers = n_headers + 1
        if (present(ttl_seconds)) n_headers = n_headers + 1
        if (present(expires_at)) n_headers = n_headers + 1

        allocate(headers(n_headers))
        n_headers = 0

        ! Add custom headers
        if (self%num_headers > 0) then
            headers(1:self%num_headers) = self%custom_headers(1:self%num_headers)
            n_headers = self%num_headers
        end if

        ! Add content-type
        if (present(content_type)) then
            self%content_type = content_type
            n_headers = n_headers + 1
            headers(n_headers) = HEADER_CONTENT_TYPE // ": " // trim(content_type)
        end if

        ! Add TTL
        if (present(ttl_seconds)) then
            write(ttl_str, '(I0)') ttl_seconds
            n_headers = n_headers + 1
            headers(n_headers) = HEADER_STREAM_TTL // ": " // trim(ttl_str)
        end if

        ! Add expires at
        if (present(expires_at)) then
            n_headers = n_headers + 1
            headers(n_headers) = HEADER_STREAM_EXPIRES_AT // ": " // trim(expires_at)
        end if

        ! Perform PUT request
        if (present(initial_data)) then
            response = self%http%put(self%url, initial_data, headers(1:n_headers))
        else
            response = self%http%put(self%url, headers=headers(1:n_headers))
        end if

        ! Handle response
        if (present(error)) then
            if (response%status_code == HTTP_CREATED .or. &
                response%status_code == HTTP_OK .or. &
                response%status_code == HTTP_NO_CONTENT) then
                error%code = DS_OK

                ! Extract content-type from response if not set
                if (.not. allocated(self%content_type)) then
                    self%content_type = trim(response%get_header(HEADER_CONTENT_TYPE))
                end if
            else
                error = response%error
            end if
        end if

        deallocate(headers)
    end subroutine stream_create

    !> Append raw bytes to the stream (POST)
    subroutine stream_append_bytes(self, data, seq, if_match, result, error)
        class(DurableStream), intent(inout) :: self
        character(len=*), intent(in) :: data
        character(len=*), intent(in), optional :: seq
        character(len=*), intent(in), optional :: if_match
        type(AppendResult), intent(out), optional :: result
        type(StreamError), intent(out), optional :: error
        type(HttpResponse) :: response
        character(len=512), allocatable :: headers(:)
        integer :: n_headers
        character(len=:), allocatable :: body

        if (.not. self%initialized) then
            if (present(error)) then
                error%code = DS_ERR_ALREADY_CLOSED
                error%message = "Stream not initialized"
            end if
            return
        end if

        ! Prepare body - wrap in array for JSON
        if (self%is_json()) then
            body = json_wrap_value(data)
        else
            body = data
        end if

        ! Build headers
        n_headers = self%num_headers + 1  ! At least content-type
        if (present(seq)) n_headers = n_headers + 1
        if (present(if_match)) n_headers = n_headers + 1

        allocate(headers(n_headers))
        n_headers = 0

        ! Add custom headers
        if (self%num_headers > 0) then
            headers(1:self%num_headers) = self%custom_headers(1:self%num_headers)
            n_headers = self%num_headers
        end if

        ! Add content-type
        n_headers = n_headers + 1
        if (allocated(self%content_type)) then
            headers(n_headers) = HEADER_CONTENT_TYPE // ": " // trim(self%content_type)
        else
            headers(n_headers) = HEADER_CONTENT_TYPE // ": " // DEFAULT_CONTENT_TYPE
        end if

        ! Add seq header
        if (present(seq)) then
            n_headers = n_headers + 1
            headers(n_headers) = HEADER_STREAM_SEQ // ": " // trim(seq)
        end if

        ! Add if-match header
        if (present(if_match)) then
            n_headers = n_headers + 1
            headers(n_headers) = HEADER_IF_MATCH // ": " // trim(if_match)
        end if

        ! Perform POST request
        response = self%http%post(self%url, body, headers(1:n_headers))

        ! Handle response
        if (present(error)) then
            if (response%status_code == HTTP_OK .or. &
                response%status_code == HTTP_NO_CONTENT) then
                error%code = DS_OK
            else
                error = response%error
            end if
        end if

        ! Extract result
        if (present(result)) then
            result%next_offset%value = trim(response%get_header(HEADER_STREAM_NEXT_OFFSET))
            result%etag = trim(response%get_header(HEADER_ETAG))
        end if

        deallocate(headers)
    end subroutine stream_append_bytes

    !> Append JSON array items to the stream
    subroutine stream_append_json(self, arr, seq, if_match, result, error)
        class(DurableStream), intent(inout) :: self
        type(JsonArray), intent(inout) :: arr
        character(len=*), intent(in), optional :: seq
        character(len=*), intent(in), optional :: if_match
        type(AppendResult), intent(out), optional :: result
        type(StreamError), intent(out), optional :: error
        character(len=:), allocatable :: json_str

        json_str = arr%to_string()
        call self%append_bytes(json_str, seq, if_match, result, error)
    end subroutine stream_append_json

    !> Delete the stream (DELETE)
    subroutine stream_delete(self, error)
        class(DurableStream), intent(inout) :: self
        type(StreamError), intent(out), optional :: error
        type(HttpResponse) :: response
        character(len=512), allocatable :: headers(:)

        if (.not. self%initialized) then
            if (present(error)) then
                error%code = DS_ERR_ALREADY_CLOSED
                error%message = "Stream not initialized"
            end if
            return
        end if

        ! Build headers
        if (self%num_headers > 0) then
            allocate(headers(self%num_headers))
            headers = self%custom_headers(1:self%num_headers)
            response = self%http%delete(self%url, headers)
            deallocate(headers)
        else
            response = self%http%delete(self%url)
        end if

        ! Handle response
        if (present(error)) then
            if (response%status_code == HTTP_NO_CONTENT .or. &
                response%status_code == HTTP_OK) then
                error%code = DS_OK
            else
                error = response%error
            end if
        end if
    end subroutine stream_delete

    !> Get stream metadata (HEAD)
    subroutine stream_head(self, metadata, error)
        class(DurableStream), intent(inout) :: self
        type(StreamMetadata), intent(out) :: metadata
        type(StreamError), intent(out), optional :: error
        type(HttpResponse) :: response
        character(len=512), allocatable :: headers(:)
        character(len=64) :: ttl_str
        integer :: ios

        if (.not. self%initialized) then
            if (present(error)) then
                error%code = DS_ERR_ALREADY_CLOSED
                error%message = "Stream not initialized"
            end if
            return
        end if

        ! Build headers
        if (self%num_headers > 0) then
            allocate(headers(self%num_headers))
            headers = self%custom_headers(1:self%num_headers)
            response = self%http%head(self%url, headers)
            deallocate(headers)
        else
            response = self%http%head(self%url)
        end if

        ! Handle response
        if (response%status_code == HTTP_OK) then
            metadata%content_type = trim(response%get_header(HEADER_CONTENT_TYPE))
            metadata%next_offset%value = trim(response%get_header(HEADER_STREAM_NEXT_OFFSET))
            metadata%etag = trim(response%get_header(HEADER_ETAG))
            metadata%expires_at = trim(response%get_header(HEADER_STREAM_EXPIRES_AT))

            ! Parse TTL
            ttl_str = trim(response%get_header(HEADER_STREAM_TTL))
            if (len_trim(ttl_str) > 0) then
                read(ttl_str, *, iostat=ios) metadata%ttl
                if (ios /= 0) metadata%ttl = -1
            end if

            if (present(error)) error%code = DS_OK
        else
            if (present(error)) error = response%error
        end if
    end subroutine stream_head

    !> Read a single chunk from the stream (GET)
    subroutine stream_read(self, chunk, offset, live_mode, cursor, error)
        class(DurableStream), intent(inout) :: self
        type(StreamChunk), intent(out) :: chunk
        type(Offset), intent(in), optional :: offset
        integer, intent(in), optional :: live_mode
        character(len=*), intent(in), optional :: cursor
        type(StreamError), intent(out), optional :: error
        type(HttpResponse) :: response
        character(len=:), allocatable :: request_url
        character(len=512), allocatable :: headers(:)
        character(len=64) :: offset_str, mode_str

        if (.not. self%initialized) then
            if (present(error)) then
                error%code = DS_ERR_ALREADY_CLOSED
                error%message = "Stream not initialized"
            end if
            return
        end if

        ! Build URL with query parameters
        request_url = self%url

        ! Add offset parameter
        if (present(offset)) then
            offset_str = offset%to_string()
        else
            offset_str = START_OFFSET
        end if
        request_url = request_url // "?" // PARAM_OFFSET // "=" // trim(offset_str)

        ! Add live mode parameter
        if (present(live_mode)) then
            select case (live_mode)
                case (LIVE_MODE_LONG_POLL)
                    mode_str = "long-poll"
                    request_url = request_url // "&" // PARAM_LIVE // "=" // trim(mode_str)
                case (LIVE_MODE_SSE)
                    mode_str = "sse"
                    request_url = request_url // "&" // PARAM_LIVE // "=" // trim(mode_str)
            end select
        end if

        ! Add cursor parameter
        if (present(cursor)) then
            if (len_trim(cursor) > 0) then
                request_url = request_url // "&" // PARAM_CURSOR // "=" // trim(cursor)
            end if
        end if

        ! Build headers
        if (self%num_headers > 0) then
            allocate(headers(self%num_headers))
            headers = self%custom_headers(1:self%num_headers)
            response = self%http%get(request_url, headers)
            deallocate(headers)
        else
            response = self%http%get(request_url)
        end if

        ! Handle response
        if (response%status_code == HTTP_OK .or. response%status_code == HTTP_NO_CONTENT) then
            chunk%next_offset%value = trim(response%get_header(HEADER_STREAM_NEXT_OFFSET))
            chunk%cursor = trim(response%get_header(HEADER_STREAM_CURSOR))
            chunk%etag = trim(response%get_header(HEADER_ETAG))
            chunk%up_to_date = response%has_header(HEADER_STREAM_UP_TO_DATE)

            if (response%status_code == HTTP_OK .and. allocated(response%body)) then
                chunk%data = response%body
            else
                chunk%data = ""
            end if

            if (present(error)) error%code = DS_OK
        else
            if (present(error)) error = response%error
        end if
    end subroutine stream_read

    !> Read all data from the stream (catches up to current end)
    subroutine stream_read_all(self, data, offset, error)
        class(DurableStream), intent(inout) :: self
        character(len=:), allocatable, intent(out) :: data
        type(Offset), intent(in), optional :: offset
        type(StreamError), intent(out), optional :: error
        type(StreamChunk) :: chunk
        type(Offset) :: current_offset
        type(StreamError) :: local_error

        data = ""

        ! Set initial offset
        if (present(offset)) then
            current_offset = offset
        else
            current_offset%value = START_OFFSET
        end if

        ! Read until up to date
        do
            call self%read(chunk, current_offset, error=local_error)

            if (local_error%code /= DS_OK) then
                if (present(error)) error = local_error
                return
            end if

            ! Append data
            if (allocated(chunk%data) .and. len(chunk%data) > 0) then
                data = data // chunk%data
            end if

            ! Update offset for next read
            if (chunk%next_offset%is_valid()) then
                current_offset = chunk%next_offset
            end if

            ! Stop if up to date
            if (chunk%up_to_date) exit
        end do

        if (present(error)) error%code = DS_OK
    end subroutine stream_read_all

    !> Read all JSON items from the stream
    subroutine stream_read_json(self, arr, offset, error)
        class(DurableStream), intent(inout) :: self
        type(JsonArray), intent(inout) :: arr
        type(Offset), intent(in), optional :: offset
        type(StreamError), intent(out), optional :: error
        character(len=:), allocatable :: data
        type(StreamError) :: local_error
        integer :: parse_error

        call arr%init()

        ! Read all data
        if (present(offset)) then
            call self%read_all(data, offset, local_error)
        else
            call self%read_all(data, error=local_error)
        end if

        if (local_error%code /= DS_OK) then
            if (present(error)) error = local_error
            return
        end if

        ! Parse JSON array
        if (len(data) > 0) then
            call json_parse_array(data, arr, parse_error)
            if (parse_error /= 0) then
                if (present(error)) then
                    error%code = DS_ERR_JSON_PARSE
                    error%message = "Failed to parse JSON response"
                end if
                return
            end if
        end if

        if (present(error)) error%code = DS_OK
    end subroutine stream_read_json

    !> Get stream URL
    function stream_get_url(self) result(url)
        class(DurableStream), intent(in) :: self
        character(len=:), allocatable :: url
        if (allocated(self%url)) then
            url = self%url
        else
            url = ""
        end if
    end function stream_get_url

    !> Get stream content type
    function stream_get_content_type(self) result(ct)
        class(DurableStream), intent(in) :: self
        character(len=:), allocatable :: ct
        if (allocated(self%content_type)) then
            ct = self%content_type
        else
            ct = ""
        end if
    end function stream_get_content_type

    !> Check if stream is JSON mode
    pure logical function stream_is_json(self)
        class(DurableStream), intent(in) :: self
        if (allocated(self%content_type)) then
            stream_is_json = (index(self%content_type, "json") > 0)
        else
            stream_is_json = .false.
        end if
    end function stream_is_json

    !> Add a custom header
    subroutine stream_add_header(self, name, value)
        class(DurableStream), intent(inout) :: self
        character(len=*), intent(in) :: name
        character(len=*), intent(in) :: value

        if (.not. allocated(self%custom_headers)) then
            allocate(self%custom_headers(16))
            self%num_headers = 0
        end if

        if (self%num_headers < size(self%custom_headers)) then
            self%num_headers = self%num_headers + 1
            self%custom_headers(self%num_headers) = trim(name) // ": " // trim(value)
        end if
    end subroutine stream_add_header

    !> Build request headers (internal)
    function stream_build_request_headers(self) result(headers)
        class(DurableStream), intent(in) :: self
        character(len=512), allocatable :: headers(:)

        if (self%num_headers > 0) then
            allocate(headers(self%num_headers))
            headers = self%custom_headers(1:self%num_headers)
        else
            allocate(headers(0))
        end if
    end function stream_build_request_headers

    !> Extract response metadata (internal)
    subroutine stream_extract_response_metadata(self, response, metadata)
        class(DurableStream), intent(in) :: self
        type(HttpResponse), intent(in) :: response
        type(StreamMetadata), intent(out) :: metadata

        metadata%content_type = trim(response%get_header(HEADER_CONTENT_TYPE))
        metadata%next_offset%value = trim(response%get_header(HEADER_STREAM_NEXT_OFFSET))
        metadata%etag = trim(response%get_header(HEADER_ETAG))
    end subroutine stream_extract_response_metadata

    !=========================================================================
    ! StreamIterator methods
    !=========================================================================

    !> Initialize iterator
    subroutine iterator_init(self, stream, offset, live_mode, cursor)
        class(StreamIterator), intent(inout) :: self
        type(DurableStream), target, intent(in) :: stream
        type(Offset), intent(in), optional :: offset
        integer, intent(in), optional :: live_mode
        character(len=*), intent(in), optional :: cursor

        self%stream => stream
        self%closed = .false.
        self%up_to_date = .false.

        if (present(offset)) then
            self%current_offset = offset
        else
            self%current_offset%value = START_OFFSET
        end if

        if (present(live_mode)) then
            self%live_mode = live_mode
        else
            self%live_mode = LIVE_MODE_NONE
        end if

        if (present(cursor)) then
            self%cursor = cursor
        else
            self%cursor = ""
        end if
    end subroutine iterator_init

    !> Get next chunk from iterator
    subroutine iterator_next(self, chunk, error)
        class(StreamIterator), intent(inout) :: self
        type(StreamChunk), intent(out) :: chunk
        type(StreamError), intent(out), optional :: error

        if (self%closed) then
            if (present(error)) then
                error%code = DS_ERR_ALREADY_CLOSED
                error%message = "Iterator already closed"
            end if
            return
        end if

        if (.not. associated(self%stream)) then
            if (present(error)) then
                error%code = DS_ERR_ALREADY_CLOSED
                error%message = "Iterator not initialized"
            end if
            return
        end if

        ! Read next chunk
        call self%stream%read(chunk, self%current_offset, self%live_mode, &
                              self%cursor, error)

        ! Update state
        if (chunk%next_offset%is_valid()) then
            self%current_offset = chunk%next_offset
        end if
        self%cursor = chunk%cursor
        self%up_to_date = chunk%up_to_date

        ! Close if up to date and not in live mode
        if (self%up_to_date .and. self%live_mode == LIVE_MODE_NONE) then
            self%closed = .true.
        end if
    end subroutine iterator_next

    !> Close iterator
    subroutine iterator_close(self)
        class(StreamIterator), intent(inout) :: self
        self%closed = .true.
        self%stream => null()
    end subroutine iterator_close

    !> Get current offset
    function iterator_get_offset(self) result(offset)
        class(StreamIterator), intent(in) :: self
        type(Offset) :: offset
        offset = self%current_offset
    end function iterator_get_offset

    !> Check if iterator is up to date
    pure logical function iterator_is_up_to_date(self)
        class(StreamIterator), intent(in) :: self
        iterator_is_up_to_date = self%up_to_date
    end function iterator_is_up_to_date

end module durable_streams
