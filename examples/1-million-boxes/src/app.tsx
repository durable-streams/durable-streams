import { RouterProvider } from "@tanstack/react-router"
import { getRouter } from "./router"
import "./styles/global.css"

// Create the router instance using the shared getRouter function
const router = getRouter()

export function App() {
  return <RouterProvider router={router} />
}
