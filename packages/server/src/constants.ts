export const STREAM_OFFSET_HEADER = `Stream-Next-Offset`
export const STREAM_CURSOR_HEADER = `Stream-Cursor`
export const STREAM_UP_TO_DATE_HEADER = `Stream-Up-To-Date`
export const STREAM_SEQ_HEADER = `Stream-Seq`
export const STREAM_TTL_HEADER = `Stream-TTL`
export const STREAM_EXPIRES_AT_HEADER = `Stream-Expires-At`
export const STREAM_SSE_DATA_ENCODING_HEADER = `Stream-SSE-Data-Encoding`
export const STREAM_CLOSED_HEADER = `Stream-Closed`

export const PRODUCER_ID_HEADER = `Producer-Id`
export const PRODUCER_EPOCH_HEADER = `Producer-Epoch`
export const PRODUCER_SEQ_HEADER = `Producer-Seq`
export const PRODUCER_EXPECTED_SEQ_HEADER = `Producer-Expected-Seq`
export const PRODUCER_RECEIVED_SEQ_HEADER = `Producer-Received-Seq`

export const SSE_OFFSET_FIELD = `streamNextOffset`
export const SSE_CURSOR_FIELD = `streamCursor`
export const SSE_UP_TO_DATE_FIELD = `upToDate`
export const SSE_CLOSED_FIELD = `streamClosed`

export const OFFSET_QUERY_PARAM = `offset`
export const LIVE_QUERY_PARAM = `live`
export const CURSOR_QUERY_PARAM = `cursor`

export const SSE_COMPATIBLE_CONTENT_TYPES: ReadonlyArray<string> = [
  `text/`,
  `application/json`,
]
