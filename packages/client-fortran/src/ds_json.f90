! durable_streams - JSON handling module
! Provides basic JSON parsing and generation for Durable Streams
module ds_json
    implicit none
    private

    ! JSON value types
    integer, parameter, public :: JSON_NULL = 0
    integer, parameter, public :: JSON_BOOL = 1
    integer, parameter, public :: JSON_NUMBER = 2
    integer, parameter, public :: JSON_STRING = 3
    integer, parameter, public :: JSON_ARRAY = 4
    integer, parameter, public :: JSON_OBJECT = 5

    ! Maximum array/object size
    integer, parameter :: MAX_ELEMENTS = 1024

    ! JSON value type (simplified for durable streams use case)
    type, public :: JsonValue
        integer :: value_type = JSON_NULL
        logical :: bool_value = .false.
        real(8) :: number_value = 0.0d0
        character(len=:), allocatable :: string_value
        character(len=:), allocatable :: raw_json  ! For pass-through
    contains
        procedure :: is_null => json_is_null
        procedure :: is_bool => json_is_bool
        procedure :: is_number => json_is_number
        procedure :: is_string => json_is_string
        procedure :: is_array => json_is_array
        procedure :: is_object => json_is_object
        procedure :: to_string => json_to_string
    end type JsonValue

    ! JSON array type
    type, public :: JsonArray
        type(JsonValue), allocatable :: items(:)
        integer :: count = 0
    contains
        procedure :: init => json_array_init
        procedure :: add_null => json_array_add_null
        procedure :: add_bool => json_array_add_bool
        procedure :: add_number => json_array_add_number
        procedure :: add_string => json_array_add_string
        procedure :: add_raw => json_array_add_raw
        procedure :: get => json_array_get
        procedure :: size => json_array_size
        procedure :: to_string => json_array_to_string
        procedure :: clear => json_array_clear
    end type JsonArray

    ! Public procedures
    public :: json_parse_array
    public :: json_escape_string
    public :: json_unescape_string
    public :: json_wrap_value
    public :: json_extract_string_field
    public :: json_is_array

contains

    !> Check if value is null
    pure logical function json_is_null(self)
        class(JsonValue), intent(in) :: self
        json_is_null = (self%value_type == JSON_NULL)
    end function json_is_null

    !> Check if value is boolean
    pure logical function json_is_bool(self)
        class(JsonValue), intent(in) :: self
        json_is_bool = (self%value_type == JSON_BOOL)
    end function json_is_bool

    !> Check if value is number
    pure logical function json_is_number(self)
        class(JsonValue), intent(in) :: self
        json_is_number = (self%value_type == JSON_NUMBER)
    end function json_is_number

    !> Check if value is string
    pure logical function json_is_string(self)
        class(JsonValue), intent(in) :: self
        json_is_string = (self%value_type == JSON_STRING)
    end function json_is_string

    !> Check if value is array
    pure logical function json_is_array(self)
        class(JsonValue), intent(in) :: self
        json_is_array = (self%value_type == JSON_ARRAY)
    end function json_is_array

    !> Check if value is object
    pure logical function json_is_object(self)
        class(JsonValue), intent(in) :: self
        json_is_object = (self%value_type == JSON_OBJECT)
    end function json_is_object

    !> Convert value to JSON string
    function json_to_string(self) result(str)
        class(JsonValue), intent(in) :: self
        character(len=:), allocatable :: str
        character(len=32) :: num_str

        select case (self%value_type)
            case (JSON_NULL)
                str = "null"
            case (JSON_BOOL)
                if (self%bool_value) then
                    str = "true"
                else
                    str = "false"
                end if
            case (JSON_NUMBER)
                write(num_str, '(G20.10)') self%number_value
                str = trim(adjustl(num_str))
            case (JSON_STRING)
                if (allocated(self%string_value)) then
                    str = '"' // json_escape_string(self%string_value) // '"'
                else
                    str = '""'
                end if
            case (JSON_ARRAY, JSON_OBJECT)
                if (allocated(self%raw_json)) then
                    str = self%raw_json
                else
                    str = "null"
                end if
            case default
                str = "null"
        end select
    end function json_to_string

    !> Initialize JSON array
    subroutine json_array_init(self, capacity)
        class(JsonArray), intent(inout) :: self
        integer, intent(in), optional :: capacity
        integer :: cap

        cap = 64
        if (present(capacity)) cap = capacity

        if (allocated(self%items)) deallocate(self%items)
        allocate(self%items(cap))
        self%count = 0
    end subroutine json_array_init

    !> Add null to array
    subroutine json_array_add_null(self)
        class(JsonArray), intent(inout) :: self

        if (.not. allocated(self%items)) call self%init()
        if (self%count >= size(self%items)) return

        self%count = self%count + 1
        self%items(self%count)%value_type = JSON_NULL
    end subroutine json_array_add_null

    !> Add boolean to array
    subroutine json_array_add_bool(self, value)
        class(JsonArray), intent(inout) :: self
        logical, intent(in) :: value

        if (.not. allocated(self%items)) call self%init()
        if (self%count >= size(self%items)) return

        self%count = self%count + 1
        self%items(self%count)%value_type = JSON_BOOL
        self%items(self%count)%bool_value = value
    end subroutine json_array_add_bool

    !> Add number to array
    subroutine json_array_add_number(self, value)
        class(JsonArray), intent(inout) :: self
        real(8), intent(in) :: value

        if (.not. allocated(self%items)) call self%init()
        if (self%count >= size(self%items)) return

        self%count = self%count + 1
        self%items(self%count)%value_type = JSON_NUMBER
        self%items(self%count)%number_value = value
    end subroutine json_array_add_number

    !> Add string to array
    subroutine json_array_add_string(self, value)
        class(JsonArray), intent(inout) :: self
        character(len=*), intent(in) :: value

        if (.not. allocated(self%items)) call self%init()
        if (self%count >= size(self%items)) return

        self%count = self%count + 1
        self%items(self%count)%value_type = JSON_STRING
        self%items(self%count)%string_value = value
    end subroutine json_array_add_string

    !> Add raw JSON to array (for objects, nested arrays)
    subroutine json_array_add_raw(self, json)
        class(JsonArray), intent(inout) :: self
        character(len=*), intent(in) :: json

        if (.not. allocated(self%items)) call self%init()
        if (self%count >= size(self%items)) return

        self%count = self%count + 1
        self%items(self%count)%value_type = JSON_OBJECT
        self%items(self%count)%raw_json = json
    end subroutine json_array_add_raw

    !> Get item from array
    function json_array_get(self, index) result(item)
        class(JsonArray), intent(in) :: self
        integer, intent(in) :: index
        type(JsonValue) :: item

        if (index >= 1 .and. index <= self%count) then
            item = self%items(index)
        else
            item%value_type = JSON_NULL
        end if
    end function json_array_get

    !> Get array size
    pure integer function json_array_size(self)
        class(JsonArray), intent(in) :: self
        json_array_size = self%count
    end function json_array_size

    !> Convert array to JSON string
    function json_array_to_string(self) result(str)
        class(JsonArray), intent(inout) :: self
        character(len=:), allocatable :: str
        character(len=:), allocatable :: item_str
        integer :: i

        str = "["
        do i = 1, self%count
            item_str = self%items(i)%to_string()
            if (i > 1) str = str // ","
            str = str // item_str
        end do
        str = str // "]"
    end function json_array_to_string

    !> Clear array
    subroutine json_array_clear(self)
        class(JsonArray), intent(inout) :: self
        self%count = 0
    end subroutine json_array_clear

    !> Parse JSON array from string (returns items as raw JSON strings)
    subroutine json_parse_array(json_str, arr, error)
        character(len=*), intent(in) :: json_str
        type(JsonArray), intent(inout) :: arr
        integer, intent(out) :: error
        integer :: pos, start_pos, depth, len_str
        character :: c
        logical :: in_string, escaped

        error = 0
        call arr%init()

        len_str = len_trim(json_str)
        if (len_str == 0) then
            error = 1
            return
        end if

        ! Skip leading whitespace
        pos = 1
        do while (pos <= len_str .and. is_whitespace(json_str(pos:pos)))
            pos = pos + 1
        end do

        ! Check for opening bracket
        if (pos > len_str .or. json_str(pos:pos) /= '[') then
            error = 1
            return
        end if
        pos = pos + 1

        ! Parse array elements
        do while (pos <= len_str)
            ! Skip whitespace
            do while (pos <= len_str .and. is_whitespace(json_str(pos:pos)))
                pos = pos + 1
            end do

            if (pos > len_str) exit
            c = json_str(pos:pos)

            ! Check for end of array
            if (c == ']') exit

            ! Skip comma
            if (c == ',') then
                pos = pos + 1
                cycle
            end if

            ! Parse element
            start_pos = pos
            depth = 0
            in_string = .false.
            escaped = .false.

            do while (pos <= len_str)
                c = json_str(pos:pos)

                if (in_string) then
                    if (escaped) then
                        escaped = .false.
                    else if (c == '\') then
                        escaped = .true.
                    else if (c == '"') then
                        in_string = .false.
                    end if
                else
                    if (c == '"') then
                        in_string = .true.
                    else if (c == '[' .or. c == '{') then
                        depth = depth + 1
                    else if (c == ']' .or. c == '}') then
                        if (depth == 0) exit
                        depth = depth - 1
                    else if (c == ',' .and. depth == 0) then
                        exit
                    end if
                end if
                pos = pos + 1
            end do

            ! Add element (trimmed)
            if (pos > start_pos) then
                call arr%add_raw(trim(adjustl(json_str(start_pos:pos-1))))
            end if
        end do
    end subroutine json_parse_array

    !> Check if string starts with array
    pure logical function json_is_array_str(str)
        character(len=*), intent(in) :: str
        integer :: i, n

        json_is_array_str = .false.
        n = len_trim(str)

        do i = 1, n
            if (.not. is_whitespace(str(i:i))) then
                json_is_array_str = (str(i:i) == '[')
                return
            end if
        end do
    end function json_is_array_str

    !> Escape string for JSON
    function json_escape_string(str) result(escaped)
        character(len=*), intent(in) :: str
        character(len=:), allocatable :: escaped
        integer :: i, n
        character :: c

        escaped = ""
        n = len(str)

        do i = 1, n
            c = str(i:i)
            select case (c)
                case ('"')
                    escaped = escaped // '\"'
                case ('\')
                    escaped = escaped // '\\'
                case (char(8))  ! backspace
                    escaped = escaped // '\b'
                case (char(12)) ! form feed
                    escaped = escaped // '\f'
                case (char(10)) ! newline
                    escaped = escaped // '\n'
                case (char(13)) ! carriage return
                    escaped = escaped // '\r'
                case (char(9))  ! tab
                    escaped = escaped // '\t'
                case default
                    escaped = escaped // c
            end select
        end do
    end function json_escape_string

    !> Unescape JSON string
    function json_unescape_string(str) result(unescaped)
        character(len=*), intent(in) :: str
        character(len=:), allocatable :: unescaped
        integer :: i, n
        logical :: escaped
        character :: c

        unescaped = ""
        n = len(str)
        escaped = .false.
        i = 1

        do while (i <= n)
            c = str(i:i)
            if (escaped) then
                select case (c)
                    case ('"')
                        unescaped = unescaped // '"'
                    case ('\')
                        unescaped = unescaped // '\'
                    case ('/')
                        unescaped = unescaped // '/'
                    case ('b')
                        unescaped = unescaped // char(8)
                    case ('f')
                        unescaped = unescaped // char(12)
                    case ('n')
                        unescaped = unescaped // char(10)
                    case ('r')
                        unescaped = unescaped // char(13)
                    case ('t')
                        unescaped = unescaped // char(9)
                    case default
                        unescaped = unescaped // c
                end select
                escaped = .false.
            else if (c == '\') then
                escaped = .true.
            else
                unescaped = unescaped // c
            end if
            i = i + 1
        end do
    end function json_unescape_string

    !> Wrap a value in JSON array (for protocol compliance)
    function json_wrap_value(value) result(wrapped)
        character(len=*), intent(in) :: value
        character(len=:), allocatable :: wrapped
        character(len=:), allocatable :: trimmed

        trimmed = trim(adjustl(value))

        ! If already an array, return as-is
        if (len(trimmed) > 0) then
            if (trimmed(1:1) == '[') then
                wrapped = trimmed
                return
            end if
        end if

        ! Wrap in array
        wrapped = '[' // trimmed // ']'
    end function json_wrap_value

    !> Extract a string field from JSON object
    function json_extract_string_field(json_str, field_name) result(value)
        character(len=*), intent(in) :: json_str
        character(len=*), intent(in) :: field_name
        character(len=:), allocatable :: value
        character(len=:), allocatable :: search_key
        integer :: pos, start_pos, end_pos, len_str
        logical :: escaped

        value = ""
        search_key = '"' // trim(field_name) // '"'
        len_str = len_trim(json_str)

        ! Find field name
        pos = index(json_str, search_key)
        if (pos == 0) return

        ! Skip to colon
        pos = pos + len(search_key)
        do while (pos <= len_str .and. json_str(pos:pos) /= ':')
            pos = pos + 1
        end do
        if (pos > len_str) return
        pos = pos + 1

        ! Skip whitespace
        do while (pos <= len_str .and. is_whitespace(json_str(pos:pos)))
            pos = pos + 1
        end do

        ! Check for string value
        if (pos > len_str .or. json_str(pos:pos) /= '"') return
        pos = pos + 1
        start_pos = pos

        ! Find end of string
        escaped = .false.
        do while (pos <= len_str)
            if (escaped) then
                escaped = .false.
            else if (json_str(pos:pos) == '\') then
                escaped = .true.
            else if (json_str(pos:pos) == '"') then
                exit
            end if
            pos = pos + 1
        end do
        end_pos = pos - 1

        if (end_pos >= start_pos) then
            value = json_unescape_string(json_str(start_pos:end_pos))
        end if
    end function json_extract_string_field

    !> Check if character is whitespace
    pure logical function is_whitespace(c)
        character, intent(in) :: c
        is_whitespace = (c == ' ' .or. c == char(9) .or. c == char(10) .or. c == char(13))
    end function is_whitespace

end module ds_json
