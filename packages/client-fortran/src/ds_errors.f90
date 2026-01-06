! durable_streams - Error handling module
! Defines error types and codes for Durable Streams operations
module ds_errors
    use ds_constants
    implicit none
    private

    ! Error codes
    integer, parameter, public :: DS_OK = 0
    integer, parameter, public :: DS_ERR_NOT_FOUND = 1
    integer, parameter, public :: DS_ERR_CONFLICT_SEQ = 2
    integer, parameter, public :: DS_ERR_CONFLICT_EXISTS = 3
    integer, parameter, public :: DS_ERR_CONTENT_TYPE_MISMATCH = 4
    integer, parameter, public :: DS_ERR_BAD_REQUEST = 5
    integer, parameter, public :: DS_ERR_UNAUTHORIZED = 6
    integer, parameter, public :: DS_ERR_FORBIDDEN = 7
    integer, parameter, public :: DS_ERR_RATE_LIMITED = 8
    integer, parameter, public :: DS_ERR_OFFSET_GONE = 9
    integer, parameter, public :: DS_ERR_NETWORK = 10
    integer, parameter, public :: DS_ERR_TIMEOUT = 11
    integer, parameter, public :: DS_ERR_CURL = 12
    integer, parameter, public :: DS_ERR_JSON_PARSE = 13
    integer, parameter, public :: DS_ERR_SSE_NOT_SUPPORTED = 14
    integer, parameter, public :: DS_ERR_ALREADY_CLOSED = 15
    integer, parameter, public :: DS_ERR_UNKNOWN = 99

    ! Stream error type
    type, public :: StreamError
        integer :: code = DS_OK
        integer :: http_status = 0
        character(len=256) :: message = ""
        character(len=64) :: operation = ""
        character(len=1024) :: url = ""
    contains
        procedure :: is_ok => stream_error_is_ok
        procedure :: to_string => stream_error_to_string
    end type StreamError

    ! Public procedures
    public :: ds_error_from_status
    public :: ds_error_message

contains

    !> Check if error indicates success
    pure logical function stream_error_is_ok(self)
        class(StreamError), intent(in) :: self
        stream_error_is_ok = (self%code == DS_OK)
    end function stream_error_is_ok

    !> Convert error to human-readable string
    function stream_error_to_string(self) result(str)
        class(StreamError), intent(in) :: self
        character(len=2048) :: str

        if (self%code == DS_OK) then
            str = "OK"
        else
            write(str, '(A,A,A,I0,A,A)') &
                trim(self%operation), ": ", &
                trim(ds_error_message(self%code)), &
                " (HTTP ", self%http_status, ")"
        end if
    end function stream_error_to_string

    !> Create error from HTTP status code
    function ds_error_from_status(http_status, operation, url) result(err)
        integer, intent(in) :: http_status
        character(len=*), intent(in) :: operation
        character(len=*), intent(in) :: url
        type(StreamError) :: err

        err%http_status = http_status
        err%operation = operation
        err%url = url

        select case (http_status)
            case (HTTP_OK, HTTP_CREATED, HTTP_NO_CONTENT, HTTP_NOT_MODIFIED)
                err%code = DS_OK
                err%message = "Success"

            case (HTTP_BAD_REQUEST)
                err%code = DS_ERR_BAD_REQUEST
                err%message = "Bad request"

            case (HTTP_UNAUTHORIZED)
                err%code = DS_ERR_UNAUTHORIZED
                err%message = "Unauthorized"

            case (HTTP_FORBIDDEN)
                err%code = DS_ERR_FORBIDDEN
                err%message = "Forbidden"

            case (HTTP_NOT_FOUND)
                err%code = DS_ERR_NOT_FOUND
                err%message = "Stream not found"

            case (HTTP_CONFLICT)
                err%code = DS_ERR_CONFLICT_SEQ
                err%message = "Conflict (sequence or configuration)"

            case (HTTP_GONE)
                err%code = DS_ERR_OFFSET_GONE
                err%message = "Offset before retention window"

            case (HTTP_TOO_MANY_REQUESTS)
                err%code = DS_ERR_RATE_LIMITED
                err%message = "Rate limited"

            case (HTTP_SERVICE_UNAVAILABLE)
                err%code = DS_ERR_NETWORK
                err%message = "Service unavailable"

            case default
                err%code = DS_ERR_UNKNOWN
                write(err%message, '(A,I0)') "Unknown error, status: ", http_status
        end select
    end function ds_error_from_status

    !> Get error message for error code
    pure function ds_error_message(code) result(msg)
        integer, intent(in) :: code
        character(len=64) :: msg

        select case (code)
            case (DS_OK)
                msg = "Success"
            case (DS_ERR_NOT_FOUND)
                msg = "Stream not found"
            case (DS_ERR_CONFLICT_SEQ)
                msg = "Sequence conflict"
            case (DS_ERR_CONFLICT_EXISTS)
                msg = "Stream already exists with different config"
            case (DS_ERR_CONTENT_TYPE_MISMATCH)
                msg = "Content type mismatch"
            case (DS_ERR_BAD_REQUEST)
                msg = "Bad request"
            case (DS_ERR_UNAUTHORIZED)
                msg = "Unauthorized"
            case (DS_ERR_FORBIDDEN)
                msg = "Forbidden"
            case (DS_ERR_RATE_LIMITED)
                msg = "Rate limited"
            case (DS_ERR_OFFSET_GONE)
                msg = "Offset before retention window"
            case (DS_ERR_NETWORK)
                msg = "Network error"
            case (DS_ERR_TIMEOUT)
                msg = "Request timeout"
            case (DS_ERR_CURL)
                msg = "CURL error"
            case (DS_ERR_JSON_PARSE)
                msg = "JSON parse error"
            case (DS_ERR_SSE_NOT_SUPPORTED)
                msg = "SSE not supported"
            case (DS_ERR_ALREADY_CLOSED)
                msg = "Stream already closed"
            case default
                msg = "Unknown error"
        end select
    end function ds_error_message

end module ds_errors
