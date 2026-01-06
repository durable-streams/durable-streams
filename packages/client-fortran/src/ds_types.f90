! durable_streams - Core types module
! Defines core types for Durable Streams operations
module ds_types
    use ds_constants
    implicit none
    private

    !> Offset type - opaque position token in a stream
    type, public :: Offset
        character(len=:), allocatable :: value
    contains
        procedure :: is_start => offset_is_start
        procedure :: to_string => offset_to_string
        procedure :: is_valid => offset_is_valid
    end type Offset

    !> Create start offset
    interface Offset
        module procedure offset_create
        module procedure offset_from_string
    end interface Offset

    !> Append result from POST operation
    type, public :: AppendResult
        type(Offset) :: next_offset
        character(len=256) :: etag = ""
    end type AppendResult

    !> Stream metadata from HEAD operation
    type, public :: StreamMetadata
        character(len=256) :: content_type = ""
        type(Offset) :: next_offset
        integer :: ttl = -1  ! -1 means not set
        character(len=64) :: expires_at = ""
        character(len=256) :: etag = ""
    end type StreamMetadata

    !> Chunk from read operation
    type, public :: StreamChunk
        type(Offset) :: next_offset
        character(len=:), allocatable :: data
        logical :: up_to_date = .false.
        character(len=256) :: cursor = ""
        character(len=256) :: etag = ""
    end type StreamChunk

    !> Create options for stream creation
    type, public :: CreateOptions
        character(len=256) :: content_type = ""
        integer :: ttl_seconds = -1  ! -1 means not set
        character(len=64) :: expires_at = ""
        character(len=:), allocatable :: initial_data
    end type CreateOptions

    !> Append options
    type, public :: AppendOptions
        character(len=256) :: seq = ""
        character(len=256) :: if_match = ""
    end type AppendOptions

    !> Read options
    type, public :: ReadOptions
        type(Offset) :: offset
        integer :: live_mode = LIVE_MODE_NONE
        character(len=256) :: cursor = ""
    end type ReadOptions

    ! Public interfaces
    public :: start_offset

contains

    !> Create offset from string
    function offset_create() result(off)
        type(Offset) :: off
        off%value = START_OFFSET
    end function offset_create

    !> Create offset from string value
    function offset_from_string(str) result(off)
        character(len=*), intent(in) :: str
        type(Offset) :: off
        off%value = trim(str)
    end function offset_from_string

    !> Check if offset is start offset
    pure logical function offset_is_start(self)
        class(Offset), intent(in) :: self
        if (allocated(self%value)) then
            offset_is_start = (self%value == START_OFFSET)
        else
            offset_is_start = .true.  ! Default to start
        end if
    end function offset_is_start

    !> Convert offset to string
    function offset_to_string(self) result(str)
        class(Offset), intent(in) :: self
        character(len=:), allocatable :: str
        if (allocated(self%value)) then
            str = self%value
        else
            str = START_OFFSET
        end if
    end function offset_to_string

    !> Check if offset is valid (allocated)
    pure logical function offset_is_valid(self)
        class(Offset), intent(in) :: self
        offset_is_valid = allocated(self%value)
    end function offset_is_valid

    !> Create a start offset constant
    function start_offset() result(off)
        type(Offset) :: off
        off%value = START_OFFSET
    end function start_offset

end module ds_types
