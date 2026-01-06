! durable_streams - HTTP utilities module
! Provides high-level HTTP operations using libcurl
module ds_http
    use, intrinsic :: iso_c_binding
    use ds_constants
    use ds_errors
    use ds_curl
    implicit none
    private

    ! HTTP response type
    type, public :: HttpResponse
        integer :: status_code = 0
        character(len=:), allocatable :: body
        type(HeaderList) :: headers
        type(StreamError) :: error
    contains
        procedure :: get_header => http_response_get_header
        procedure :: has_header => http_response_has_header
        procedure :: is_success => http_response_is_success
    end type HttpResponse

    ! HTTP client configuration
    type, public :: HttpClientConfig
        integer :: timeout = DEFAULT_TIMEOUT
        integer :: connect_timeout = 10
        logical :: follow_redirects = .true.
        integer :: max_retries = 3
        real :: retry_delay = 0.1  ! seconds
        real :: retry_multiplier = 2.0
        real :: max_retry_delay = 60.0
    end type HttpClientConfig

    ! HTTP client type
    type, public :: HttpClient
        type(HttpClientConfig) :: config
        logical :: initialized = .false.
    contains
        procedure :: init => http_client_init
        procedure :: cleanup => http_client_cleanup
        procedure :: get => http_client_get
        procedure :: post => http_client_post
        procedure :: put => http_client_put
        procedure :: delete => http_client_delete
        procedure :: head => http_client_head
    end type HttpClient

    ! Module variables for callbacks
    type(ResponseBuffer), target, save :: g_body_buffer
    type(HeaderList), target, save :: g_header_list

    ! Public procedures
    public :: http_build_url
    public :: http_parse_header_line

contains

    !> Get header value from response
    function http_response_get_header(self, name) result(value)
        class(HttpResponse), intent(in) :: self
        character(len=*), intent(in) :: name
        character(len=2048) :: value
        value = header_list_get(self%headers, name)
    end function http_response_get_header

    !> Check if response has header
    function http_response_has_header(self, name) result(has)
        class(HttpResponse), intent(in) :: self
        character(len=*), intent(in) :: name
        logical :: has
        character(len=2048) :: value
        value = header_list_get(self%headers, name)
        has = (len_trim(value) > 0)
    end function http_response_has_header

    !> Check if response indicates success
    pure logical function http_response_is_success(self)
        class(HttpResponse), intent(in) :: self
        http_response_is_success = (self%status_code >= 200 .and. self%status_code < 300)
    end function http_response_is_success

    !> Initialize HTTP client
    subroutine http_client_init(self, config)
        class(HttpClient), intent(inout) :: self
        type(HttpClientConfig), intent(in), optional :: config
        integer :: code

        if (present(config)) then
            self%config = config
        end if

        code = curl_global_init()
        self%initialized = (code == 0)
    end subroutine http_client_init

    !> Cleanup HTTP client
    subroutine http_client_cleanup(self)
        class(HttpClient), intent(inout) :: self

        if (self%initialized) then
            call curl_global_cleanup()
            self%initialized = .false.
        end if
    end subroutine http_client_cleanup

    !> Body write callback for CURL
    function body_write_callback(ptr, size, nmemb, userdata) bind(c)
        type(c_ptr), value :: ptr
        integer(c_size_t), value :: size, nmemb
        type(c_ptr), value :: userdata
        integer(c_size_t) :: body_write_callback
        integer(c_size_t) :: total_size
        character(len=:), allocatable :: chunk
        character, pointer :: c_chars(:)
        integer :: i

        total_size = size * nmemb
        body_write_callback = total_size

        if (total_size == 0) return

        ! Convert C pointer to Fortran string
        call c_f_pointer(ptr, c_chars, [total_size])
        allocate(character(len=total_size) :: chunk)
        do i = 1, int(total_size)
            chunk(i:i) = c_chars(i)
        end do

        ! Append to buffer
        call buffer_append(g_body_buffer, chunk, int(total_size))

        deallocate(chunk)
    end function body_write_callback

    !> Header write callback for CURL
    function header_write_callback(ptr, size, nmemb, userdata) bind(c)
        type(c_ptr), value :: ptr
        integer(c_size_t), value :: size, nmemb
        type(c_ptr), value :: userdata
        integer(c_size_t) :: header_write_callback
        integer(c_size_t) :: total_size
        character(len=:), allocatable :: line
        character, pointer :: c_chars(:)
        character(len=256) :: name
        character(len=2048) :: value
        integer :: i, colon_pos

        total_size = size * nmemb
        header_write_callback = total_size

        if (total_size == 0) return

        ! Convert C pointer to Fortran string
        call c_f_pointer(ptr, c_chars, [total_size])
        allocate(character(len=total_size) :: line)
        do i = 1, int(total_size)
            line(i:i) = c_chars(i)
        end do

        ! Parse header line
        call http_parse_header_line(trim(line), name, value)
        if (len_trim(name) > 0) then
            call header_list_add(g_header_list, trim(name), trim(value))
        end if

        deallocate(line)
    end function header_write_callback

    !> Perform HTTP request
    function http_do_request(self, method, url, headers, body) result(response)
        class(HttpClient), intent(in) :: self
        character(len=*), intent(in) :: method
        character(len=*), intent(in) :: url
        character(len=*), intent(in), optional :: headers(:)
        character(len=*), intent(in), optional :: body
        type(HttpResponse) :: response
        type(CurlHandle) :: curl
        type(CurlSlist) :: header_list
        integer :: code, i
        integer(c_long) :: status_code
        type(c_funptr) :: body_cb, header_cb

        ! Initialize response
        call header_list_init(response%headers)
        response%status_code = 0

        ! Initialize curl
        curl = curl_easy_init()
        if (.not. c_associated(curl%ptr)) then
            response%error%code = DS_ERR_CURL
            response%error%message = "Failed to initialize CURL"
            return
        end if

        ! Initialize global buffers
        call buffer_init(g_body_buffer)
        call header_list_init(g_header_list)

        ! Set URL
        code = curl_easy_setopt_str(curl, CURLOPT_URL, url)

        ! Set method
        select case (trim(method))
            case ("POST")
                code = curl_easy_setopt_long(curl, CURLOPT_POST, 1_c_long)
                if (present(body)) then
                    code = curl_easy_setopt_str(curl, CURLOPT_POSTFIELDS, body)
                    code = curl_easy_setopt_long(curl, CURLOPT_POSTFIELDSIZE, int(len(body), c_long))
                else
                    code = curl_easy_setopt_str(curl, CURLOPT_POSTFIELDS, "")
                    code = curl_easy_setopt_long(curl, CURLOPT_POSTFIELDSIZE, 0_c_long)
                end if
            case ("PUT")
                code = curl_easy_setopt_str(curl, CURLOPT_CUSTOMREQUEST, "PUT")
                if (present(body)) then
                    code = curl_easy_setopt_str(curl, CURLOPT_POSTFIELDS, body)
                    code = curl_easy_setopt_long(curl, CURLOPT_POSTFIELDSIZE, int(len(body), c_long))
                end if
            case ("DELETE")
                code = curl_easy_setopt_str(curl, CURLOPT_CUSTOMREQUEST, "DELETE")
            case ("HEAD")
                code = curl_easy_setopt_long(curl, CURLOPT_NOBODY, 1_c_long)
        end select

        ! Set headers
        if (present(headers)) then
            do i = 1, size(headers)
                header_list = curl_slist_append(header_list, headers(i))
            end do
            code = curl_easy_setopt_ptr(curl, CURLOPT_HTTPHEADER, header_list%ptr)
        end if

        ! Set callbacks
        body_cb = c_funloc(body_write_callback)
        header_cb = c_funloc(header_write_callback)
        code = curl_easy_setopt_func(curl, CURLOPT_WRITEFUNCTION, body_cb)
        code = curl_easy_setopt_func(curl, CURLOPT_HEADERFUNCTION, header_cb)

        ! Set timeouts
        code = curl_easy_setopt_long(curl, CURLOPT_TIMEOUT, int(self%config%timeout, c_long))
        code = curl_easy_setopt_long(curl, CURLOPT_CONNECTTIMEOUT, int(self%config%connect_timeout, c_long))

        ! Follow redirects
        if (self%config%follow_redirects) then
            code = curl_easy_setopt_long(curl, CURLOPT_FOLLOWLOCATION, 1_c_long)
        end if

        ! Perform request
        code = curl_easy_perform(curl)

        if (code /= CURLE_OK) then
            if (code == CURLE_OPERATION_TIMEDOUT) then
                response%error%code = DS_ERR_TIMEOUT
                response%error%message = "Request timed out"
            else if (code == CURLE_COULDNT_CONNECT) then
                response%error%code = DS_ERR_NETWORK
                response%error%message = "Could not connect"
            else
                response%error%code = DS_ERR_CURL
                write(response%error%message, '(A,I0)') "CURL error: ", code
            end if
        else
            ! Get status code
            code = curl_easy_getinfo_long(curl, CURLINFO_RESPONSE_CODE, status_code)
            response%status_code = int(status_code)

            ! Get response body
            response%body = buffer_get_data(g_body_buffer)

            ! Copy headers
            response%headers = g_header_list

            ! Create error from status if needed
            if (response%status_code >= 400) then
                response%error = ds_error_from_status(response%status_code, method, url)
            end if
        end if

        ! Cleanup
        call curl_slist_free_all(header_list)
        call curl_easy_cleanup(curl)
    end function http_do_request

    !> HTTP GET request
    function http_client_get(self, url, headers) result(response)
        class(HttpClient), intent(in) :: self
        character(len=*), intent(in) :: url
        character(len=*), intent(in), optional :: headers(:)
        type(HttpResponse) :: response

        if (present(headers)) then
            response = http_do_request(self, "GET", url, headers)
        else
            response = http_do_request(self, "GET", url)
        end if
    end function http_client_get

    !> HTTP POST request
    function http_client_post(self, url, body, headers) result(response)
        class(HttpClient), intent(in) :: self
        character(len=*), intent(in) :: url
        character(len=*), intent(in), optional :: body
        character(len=*), intent(in), optional :: headers(:)
        type(HttpResponse) :: response

        if (present(headers) .and. present(body)) then
            response = http_do_request(self, "POST", url, headers, body)
        else if (present(headers)) then
            response = http_do_request(self, "POST", url, headers)
        else if (present(body)) then
            response = http_do_request(self, "POST", url, body=body)
        else
            response = http_do_request(self, "POST", url)
        end if
    end function http_client_post

    !> HTTP PUT request
    function http_client_put(self, url, body, headers) result(response)
        class(HttpClient), intent(in) :: self
        character(len=*), intent(in) :: url
        character(len=*), intent(in), optional :: body
        character(len=*), intent(in), optional :: headers(:)
        type(HttpResponse) :: response

        if (present(headers) .and. present(body)) then
            response = http_do_request(self, "PUT", url, headers, body)
        else if (present(headers)) then
            response = http_do_request(self, "PUT", url, headers)
        else if (present(body)) then
            response = http_do_request(self, "PUT", url, body=body)
        else
            response = http_do_request(self, "PUT", url)
        end if
    end function http_client_put

    !> HTTP DELETE request
    function http_client_delete(self, url, headers) result(response)
        class(HttpClient), intent(in) :: self
        character(len=*), intent(in) :: url
        character(len=*), intent(in), optional :: headers(:)
        type(HttpResponse) :: response

        if (present(headers)) then
            response = http_do_request(self, "DELETE", url, headers)
        else
            response = http_do_request(self, "DELETE", url)
        end if
    end function http_client_delete

    !> HTTP HEAD request
    function http_client_head(self, url, headers) result(response)
        class(HttpClient), intent(in) :: self
        character(len=*), intent(in) :: url
        character(len=*), intent(in), optional :: headers(:)
        type(HttpResponse) :: response

        if (present(headers)) then
            response = http_do_request(self, "HEAD", url, headers)
        else
            response = http_do_request(self, "HEAD", url)
        end if
    end function http_client_head

    !> Build URL with query parameters
    function http_build_url(base_url, params) result(url)
        character(len=*), intent(in) :: base_url
        character(len=*), intent(in), optional :: params(:, :)  ! (:,2) pairs of name, value
        character(len=:), allocatable :: url
        integer :: i

        url = trim(base_url)

        if (present(params)) then
            if (size(params, 1) > 0) then
                url = url // "?"
                do i = 1, size(params, 1)
                    if (i > 1) url = url // "&"
                    url = url // trim(params(i, 1)) // "=" // trim(params(i, 2))
                end do
            end if
        end if
    end function http_build_url

    !> Parse HTTP header line into name and value
    subroutine http_parse_header_line(line, name, value)
        character(len=*), intent(in) :: line
        character(len=*), intent(out) :: name
        character(len=*), intent(out) :: value
        integer :: colon_pos, start_pos

        name = ""
        value = ""

        ! Find colon
        colon_pos = index(line, ":")
        if (colon_pos == 0) return

        ! Extract name (before colon)
        name = trim(adjustl(line(1:colon_pos-1)))

        ! Extract value (after colon, trimmed)
        start_pos = colon_pos + 1
        do while (start_pos <= len_trim(line) .and. line(start_pos:start_pos) == ' ')
            start_pos = start_pos + 1
        end do

        if (start_pos <= len_trim(line)) then
            value = trim(line(start_pos:))
            ! Remove trailing CR/LF
            do while (len_trim(value) > 0)
                if (value(len_trim(value):len_trim(value)) == char(13) .or. &
                    value(len_trim(value):len_trim(value)) == char(10)) then
                    value = value(1:len_trim(value)-1)
                else
                    exit
                end if
            end do
        end if
    end subroutine http_parse_header_line

end module ds_http
