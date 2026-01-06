! durable_streams - Constants module
! Defines protocol constants and headers for Durable Streams
module ds_constants
    implicit none
    private

    ! Protocol version
    character(len=*), parameter, public :: DS_VERSION = "1.0.0"

    ! HTTP response header names
    character(len=*), parameter, public :: HEADER_STREAM_NEXT_OFFSET = "Stream-Next-Offset"
    character(len=*), parameter, public :: HEADER_STREAM_CURSOR = "Stream-Cursor"
    character(len=*), parameter, public :: HEADER_STREAM_UP_TO_DATE = "Stream-Up-To-Date"
    character(len=*), parameter, public :: HEADER_CONTENT_TYPE = "Content-Type"
    character(len=*), parameter, public :: HEADER_ETAG = "ETag"
    character(len=*), parameter, public :: HEADER_LOCATION = "Location"

    ! HTTP request header names
    character(len=*), parameter, public :: HEADER_STREAM_SEQ = "Stream-Seq"
    character(len=*), parameter, public :: HEADER_STREAM_TTL = "Stream-TTL"
    character(len=*), parameter, public :: HEADER_STREAM_EXPIRES_AT = "Stream-Expires-At"
    character(len=*), parameter, public :: HEADER_IF_MATCH = "If-Match"

    ! Query parameter names
    character(len=*), parameter, public :: PARAM_OFFSET = "offset"
    character(len=*), parameter, public :: PARAM_LIVE = "live"
    character(len=*), parameter, public :: PARAM_CURSOR = "cursor"

    ! SSE field names (camelCase as per protocol)
    character(len=*), parameter, public :: SSE_OFFSET_FIELD = "streamNextOffset"
    character(len=*), parameter, public :: SSE_CURSOR_FIELD = "streamCursor"

    ! Special offset value for start of stream
    character(len=*), parameter, public :: START_OFFSET = "-1"

    ! Live mode values
    integer, parameter, public :: LIVE_MODE_NONE = 0
    integer, parameter, public :: LIVE_MODE_AUTO = 1
    integer, parameter, public :: LIVE_MODE_LONG_POLL = 2
    integer, parameter, public :: LIVE_MODE_SSE = 3

    ! HTTP status codes
    integer, parameter, public :: HTTP_OK = 200
    integer, parameter, public :: HTTP_CREATED = 201
    integer, parameter, public :: HTTP_NO_CONTENT = 204
    integer, parameter, public :: HTTP_NOT_MODIFIED = 304
    integer, parameter, public :: HTTP_BAD_REQUEST = 400
    integer, parameter, public :: HTTP_UNAUTHORIZED = 401
    integer, parameter, public :: HTTP_FORBIDDEN = 403
    integer, parameter, public :: HTTP_NOT_FOUND = 404
    integer, parameter, public :: HTTP_CONFLICT = 409
    integer, parameter, public :: HTTP_GONE = 410
    integer, parameter, public :: HTTP_TOO_MANY_REQUESTS = 429
    integer, parameter, public :: HTTP_SERVICE_UNAVAILABLE = 503

    ! Default timeouts (in seconds)
    integer, parameter, public :: DEFAULT_TIMEOUT = 30
    integer, parameter, public :: DEFAULT_LONG_POLL_TIMEOUT = 60

    ! Default content type
    character(len=*), parameter, public :: DEFAULT_CONTENT_TYPE = "application/octet-stream"
    character(len=*), parameter, public :: JSON_CONTENT_TYPE = "application/json"
    character(len=*), parameter, public :: SSE_CONTENT_TYPE = "text/event-stream"

    ! Buffer sizes
    integer, parameter, public :: MAX_HEADER_SIZE = 8192
    integer, parameter, public :: MAX_URL_SIZE = 4096
    integer, parameter, public :: INITIAL_BUFFER_SIZE = 65536

end module ds_constants
