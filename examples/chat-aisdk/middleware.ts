import { NextResponse } from "next/server"
import { isAuthorized } from "./app/lib/auth"

export function middleware(request: Request) {
  if (isAuthorized(request)) return NextResponse.next()
  return new NextResponse(`Unauthorized`, {
    status: 401,
    headers: { "Cache-Control": `no-store` },
  })
}

export const config = {
  matcher: [`/((?!_next/static|_next/image|favicon.ico).*)`],
}
