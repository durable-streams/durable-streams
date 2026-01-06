! durable_streams - libcurl C binding module
! Provides Fortran interface to libcurl for HTTP operations
module ds_curl
    use, intrinsic :: iso_c_binding
    implicit none
    private

    ! CURL handle type (opaque pointer)
    type, public :: CurlHandle
        type(c_ptr) :: ptr = c_null_ptr
    end type CurlHandle

    ! CURL slist type for headers (opaque pointer)
    type, public :: CurlSlist
        type(c_ptr) :: ptr = c_null_ptr
    end type CurlSlist

    ! CURL option constants
    integer(c_int), parameter, public :: CURLOPT_URL = 10002
    integer(c_int), parameter, public :: CURLOPT_HTTPHEADER = 10023
    integer(c_int), parameter, public :: CURLOPT_WRITEFUNCTION = 20011
    integer(c_int), parameter, public :: CURLOPT_WRITEDATA = 10001
    integer(c_int), parameter, public :: CURLOPT_HEADERFUNCTION = 20079
    integer(c_int), parameter, public :: CURLOPT_HEADERDATA = 10029
    integer(c_int), parameter, public :: CURLOPT_POST = 47
    integer(c_int), parameter, public :: CURLOPT_POSTFIELDS = 10015
    integer(c_int), parameter, public :: CURLOPT_POSTFIELDSIZE = 60
    integer(c_int), parameter, public :: CURLOPT_CUSTOMREQUEST = 10036
    integer(c_int), parameter, public :: CURLOPT_NOBODY = 44
    integer(c_int), parameter, public :: CURLOPT_TIMEOUT = 13
    integer(c_int), parameter, public :: CURLOPT_CONNECTTIMEOUT = 78
    integer(c_int), parameter, public :: CURLOPT_FOLLOWLOCATION = 52
    integer(c_int), parameter, public :: CURLOPT_UPLOAD = 46

    ! CURL info constants
    integer(c_int), parameter, public :: CURLINFO_RESPONSE_CODE = 2097154

    ! CURL result codes
    integer(c_int), parameter, public :: CURLE_OK = 0
    integer(c_int), parameter, public :: CURLE_COULDNT_CONNECT = 7
    integer(c_int), parameter, public :: CURLE_OPERATION_TIMEDOUT = 28

    ! Response buffer for callback
    type, public :: ResponseBuffer
        character(len=:), allocatable :: data
        integer :: length = 0
        integer :: capacity = 0
    end type ResponseBuffer

    ! Header storage type
    type, public :: HeaderStorage
        character(len=256) :: name = ""
        character(len=2048) :: value = ""
    end type HeaderStorage

    type, public :: HeaderList
        type(HeaderStorage), allocatable :: headers(:)
        integer :: count = 0
    end type HeaderList

    ! Public procedures
    public :: curl_global_init
    public :: curl_global_cleanup
    public :: curl_easy_init
    public :: curl_easy_cleanup
    public :: curl_easy_setopt_str
    public :: curl_easy_setopt_long
    public :: curl_easy_setopt_ptr
    public :: curl_easy_setopt_func
    public :: curl_easy_perform
    public :: curl_easy_getinfo_long
    public :: curl_slist_append
    public :: curl_slist_free_all
    public :: buffer_init
    public :: buffer_append
    public :: buffer_get_data
    public :: header_list_init
    public :: header_list_add
    public :: header_list_get

    ! C function interfaces
    interface
        ! curl_global_init
        function c_curl_global_init(flags) bind(c, name='curl_global_init')
            import :: c_int, c_long
            integer(c_long), value :: flags
            integer(c_int) :: c_curl_global_init
        end function c_curl_global_init

        ! curl_global_cleanup
        subroutine c_curl_global_cleanup() bind(c, name='curl_global_cleanup')
        end subroutine c_curl_global_cleanup

        ! curl_easy_init
        function c_curl_easy_init() bind(c, name='curl_easy_init')
            import :: c_ptr
            type(c_ptr) :: c_curl_easy_init
        end function c_curl_easy_init

        ! curl_easy_cleanup
        subroutine c_curl_easy_cleanup(handle) bind(c, name='curl_easy_cleanup')
            import :: c_ptr
            type(c_ptr), value :: handle
        end subroutine c_curl_easy_cleanup

        ! curl_easy_setopt (multiple overloads needed)
        function c_curl_easy_setopt_str(handle, option, value) bind(c, name='curl_easy_setopt')
            import :: c_ptr, c_int, c_char
            type(c_ptr), value :: handle
            integer(c_int), value :: option
            character(c_char), intent(in) :: value(*)
            integer(c_int) :: c_curl_easy_setopt_str
        end function c_curl_easy_setopt_str

        function c_curl_easy_setopt_long(handle, option, value) bind(c, name='curl_easy_setopt')
            import :: c_ptr, c_int, c_long
            type(c_ptr), value :: handle
            integer(c_int), value :: option
            integer(c_long), value :: value
            integer(c_int) :: c_curl_easy_setopt_long
        end function c_curl_easy_setopt_long

        function c_curl_easy_setopt_ptr(handle, option, value) bind(c, name='curl_easy_setopt')
            import :: c_ptr, c_int
            type(c_ptr), value :: handle
            integer(c_int), value :: option
            type(c_ptr), value :: value
            integer(c_int) :: c_curl_easy_setopt_ptr
        end function c_curl_easy_setopt_ptr

        function c_curl_easy_setopt_func(handle, option, func) bind(c, name='curl_easy_setopt')
            import :: c_ptr, c_int, c_funptr
            type(c_ptr), value :: handle
            integer(c_int), value :: option
            type(c_funptr), value :: func
            integer(c_int) :: c_curl_easy_setopt_func
        end function c_curl_easy_setopt_func

        ! curl_easy_perform
        function c_curl_easy_perform(handle) bind(c, name='curl_easy_perform')
            import :: c_ptr, c_int
            type(c_ptr), value :: handle
            integer(c_int) :: c_curl_easy_perform
        end function c_curl_easy_perform

        ! curl_easy_getinfo
        function c_curl_easy_getinfo_long(handle, info, value) bind(c, name='curl_easy_getinfo')
            import :: c_ptr, c_int, c_long
            type(c_ptr), value :: handle
            integer(c_int), value :: info
            integer(c_long), intent(out) :: value
            integer(c_int) :: c_curl_easy_getinfo_long
        end function c_curl_easy_getinfo_long

        ! curl_slist_append
        function c_curl_slist_append(list, str) bind(c, name='curl_slist_append')
            import :: c_ptr, c_char
            type(c_ptr), value :: list
            character(c_char), intent(in) :: str(*)
            type(c_ptr) :: c_curl_slist_append
        end function c_curl_slist_append

        ! curl_slist_free_all
        subroutine c_curl_slist_free_all(list) bind(c, name='curl_slist_free_all')
            import :: c_ptr
            type(c_ptr), value :: list
        end subroutine c_curl_slist_free_all
    end interface

contains

    !> Initialize CURL globally (call once at program start)
    function curl_global_init() result(code)
        integer :: code
        ! CURL_GLOBAL_DEFAULT = 3
        code = int(c_curl_global_init(3_c_long))
    end function curl_global_init

    !> Cleanup CURL globally (call once at program end)
    subroutine curl_global_cleanup()
        call c_curl_global_cleanup()
    end subroutine curl_global_cleanup

    !> Initialize a new CURL easy handle
    function curl_easy_init() result(handle)
        type(CurlHandle) :: handle
        handle%ptr = c_curl_easy_init()
    end function curl_easy_init

    !> Cleanup a CURL easy handle
    subroutine curl_easy_cleanup(handle)
        type(CurlHandle), intent(inout) :: handle
        if (c_associated(handle%ptr)) then
            call c_curl_easy_cleanup(handle%ptr)
            handle%ptr = c_null_ptr
        end if
    end subroutine curl_easy_cleanup

    !> Set a string option on CURL handle
    function curl_easy_setopt_str(handle, option, value) result(code)
        type(CurlHandle), intent(in) :: handle
        integer, intent(in) :: option
        character(len=*), intent(in) :: value
        integer :: code
        character(len=len_trim(value)+1) :: c_value

        c_value = trim(value) // c_null_char
        code = int(c_curl_easy_setopt_str(handle%ptr, int(option, c_int), c_value))
    end function curl_easy_setopt_str

    !> Set a long integer option on CURL handle
    function curl_easy_setopt_long(handle, option, value) result(code)
        type(CurlHandle), intent(in) :: handle
        integer, intent(in) :: option
        integer(c_long), intent(in) :: value
        integer :: code

        code = int(c_curl_easy_setopt_long(handle%ptr, int(option, c_int), value))
    end function curl_easy_setopt_long

    !> Set a pointer option on CURL handle
    function curl_easy_setopt_ptr(handle, option, value) result(code)
        type(CurlHandle), intent(in) :: handle
        integer, intent(in) :: option
        type(c_ptr), intent(in) :: value
        integer :: code

        code = int(c_curl_easy_setopt_ptr(handle%ptr, int(option, c_int), value))
    end function curl_easy_setopt_ptr

    !> Set a callback function on CURL handle
    function curl_easy_setopt_func(handle, option, func) result(code)
        type(CurlHandle), intent(in) :: handle
        integer, intent(in) :: option
        type(c_funptr), intent(in) :: func
        integer :: code

        code = int(c_curl_easy_setopt_func(handle%ptr, int(option, c_int), func))
    end function curl_easy_setopt_func

    !> Perform the CURL request
    function curl_easy_perform(handle) result(code)
        type(CurlHandle), intent(in) :: handle
        integer :: code

        code = int(c_curl_easy_perform(handle%ptr))
    end function curl_easy_perform

    !> Get long info from CURL handle
    function curl_easy_getinfo_long(handle, info, value) result(code)
        type(CurlHandle), intent(in) :: handle
        integer, intent(in) :: info
        integer(c_long), intent(out) :: value
        integer :: code

        code = int(c_curl_easy_getinfo_long(handle%ptr, int(info, c_int), value))
    end function curl_easy_getinfo_long

    !> Append a string to a CURL slist
    function curl_slist_append(list, str) result(new_list)
        type(CurlSlist), intent(in) :: list
        character(len=*), intent(in) :: str
        type(CurlSlist) :: new_list
        character(len=len_trim(str)+1) :: c_str

        c_str = trim(str) // c_null_char
        new_list%ptr = c_curl_slist_append(list%ptr, c_str)
    end function curl_slist_append

    !> Free a CURL slist
    subroutine curl_slist_free_all(list)
        type(CurlSlist), intent(inout) :: list
        if (c_associated(list%ptr)) then
            call c_curl_slist_free_all(list%ptr)
            list%ptr = c_null_ptr
        end if
    end subroutine curl_slist_free_all

    !> Initialize a response buffer
    subroutine buffer_init(buf, initial_size)
        type(ResponseBuffer), intent(inout) :: buf
        integer, intent(in), optional :: initial_size
        integer :: size

        size = 65536
        if (present(initial_size)) size = initial_size

        if (allocated(buf%data)) deallocate(buf%data)
        allocate(character(len=size) :: buf%data)
        buf%length = 0
        buf%capacity = size
    end subroutine buffer_init

    !> Append data to response buffer
    subroutine buffer_append(buf, data, length)
        type(ResponseBuffer), intent(inout) :: buf
        character(len=*), intent(in) :: data
        integer, intent(in) :: length
        character(len=:), allocatable :: new_data
        integer :: new_capacity

        ! Grow buffer if needed
        if (buf%length + length > buf%capacity) then
            new_capacity = max(buf%capacity * 2, buf%length + length)
            allocate(character(len=new_capacity) :: new_data)
            new_data(1:buf%length) = buf%data(1:buf%length)
            call move_alloc(new_data, buf%data)
            buf%capacity = new_capacity
        end if

        ! Append data
        buf%data(buf%length+1:buf%length+length) = data(1:length)
        buf%length = buf%length + length
    end subroutine buffer_append

    !> Get data from buffer as string
    function buffer_get_data(buf) result(data)
        type(ResponseBuffer), intent(in) :: buf
        character(len=:), allocatable :: data

        if (buf%length > 0) then
            data = buf%data(1:buf%length)
        else
            data = ""
        end if
    end function buffer_get_data

    !> Initialize header list
    subroutine header_list_init(list, max_headers)
        type(HeaderList), intent(inout) :: list
        integer, intent(in), optional :: max_headers
        integer :: n

        n = 32
        if (present(max_headers)) n = max_headers

        if (allocated(list%headers)) deallocate(list%headers)
        allocate(list%headers(n))
        list%count = 0
    end subroutine header_list_init

    !> Add a header to the list
    subroutine header_list_add(list, name, value)
        type(HeaderList), intent(inout) :: list
        character(len=*), intent(in) :: name
        character(len=*), intent(in) :: value

        if (list%count < size(list%headers)) then
            list%count = list%count + 1
            list%headers(list%count)%name = name
            list%headers(list%count)%value = value
        end if
    end subroutine header_list_add

    !> Get a header value by name (case-insensitive)
    function header_list_get(list, name) result(value)
        type(HeaderList), intent(in) :: list
        character(len=*), intent(in) :: name
        character(len=2048) :: value
        integer :: i
        character(len=256) :: lower_name, lower_header

        value = ""
        lower_name = to_lower(trim(name))

        do i = 1, list%count
            lower_header = to_lower(trim(list%headers(i)%name))
            if (lower_name == lower_header) then
                value = list%headers(i)%value
                return
            end if
        end do
    end function header_list_get

    !> Convert string to lowercase
    pure function to_lower(str) result(lower)
        character(len=*), intent(in) :: str
        character(len=len(str)) :: lower
        integer :: i, ic

        do i = 1, len(str)
            ic = ichar(str(i:i))
            if (ic >= ichar('A') .and. ic <= ichar('Z')) then
                lower(i:i) = char(ic + 32)
            else
                lower(i:i) = str(i:i)
            end if
        end do
    end function to_lower

end module ds_curl
